import qrcode from "qrcode-terminal";
import { Client, LocalAuth, Poll } from "whatsapp-web.js";
import type { Contact, Message, PollVote } from "whatsapp-web.js";

import type { WhatsappConfig } from "./config";
import type { IncomingMessage, IncomingPollVote, MediaPayload } from "./types";

export type MessageHandler = (message: IncomingMessage) => Promise<void>;
export type PollVoteHandler = (vote: IncomingPollVote) => Promise<void>;

export function startWhatsAppListener(
  config: WhatsappConfig,
  handler: MessageHandler,
  pollVoteHandler?: PollVoteHandler
): void {
  const puppeteerConfig: {
    headless: boolean;
    args: string[];
    executablePath?: string;
  } = {
    headless: config.headless,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
    ],
  };

  if (config.executablePath) {
    puppeteerConfig.executablePath = config.executablePath;
  }

  const authOptions: { dataPath: string; clientId?: string } = {
    dataPath: config.sessionDir,
  };
  if (config.clientId) {
    authOptions.clientId = config.clientId;
  }

  const client = new Client({
    authStrategy: new LocalAuth(authOptions),
    puppeteer: puppeteerConfig,
    takeoverOnConflict: true,
    takeoverTimeoutMs: 15000,
    webVersionCache: { type: "none" },
    authTimeoutMs: 60000,
    bypassCSP: true,
  });

  let activeGroupId: string | null = null;
  let selfId: string | null = null;
  let selfNumber: string | null = null;
  let readyHandled = false;
  let readyHandling = false;
  let readyWatchdog: NodeJS.Timeout | null = null;
  let readyStartedAt = 0;
  let lastKnownState: string | null = null;
  let conflictTakeoverAttempted = false;
  let watchdogRunning = false;
  let restartAttempts = 0;
  let eventHooksReady = false;
  let eventHookAttempts = 0;
  let eventHookRetryTimer: NodeJS.Timeout | null = null;
  const seenMessageIds = new Set<string>();
  const ignoredMessageIds = new Set<string>();
  const outgoingBodies = new Map<string, number>();
  const senderInfoCache = new Map<
    string,
    { label: string; number: string | null }
  >();

  function normalizeGroupName(value: string): string {
    return value.trim().replace(/\s+/g, " ").toLowerCase();
  }

  type RawChat = { id: string; name: string; isGroup: boolean };

  async function getRawChats(): Promise<RawChat[]> {
    const page = (
      client as unknown as {
        pupPage?: {
          evaluate: <T>(fn: () => T | Promise<T>) => Promise<T>;
        };
      }
    ).pupPage;
    if (!page?.evaluate) {
      throw new Error("No se pudo acceder al navegador para leer chats.");
    }
    return await page.evaluate(() => {
      const store = (window as unknown as {
        Store?: { Chat?: { getModelsArray?: () => unknown[] } };
      }).Store;
      const models = store?.Chat?.getModelsArray?.() || [];
      return models
        .map((chat) => {
          const model = chat as {
            id?: { _serialized?: string };
            name?: string;
            formattedTitle?: string;
            groupMetadata?: { subject?: string };
            displayName?: string;
            pushname?: string;
            isGroup?: boolean;
          };
          const id = model.id?._serialized || "";
          const name =
            model.name ||
            model.formattedTitle ||
            model.groupMetadata?.subject ||
            model.displayName ||
            model.pushname ||
            "";
          const isGroup = Boolean(model.isGroup) || id.endsWith("@g.us");
          return { id, name, isGroup };
        })
        .filter((entry) => entry.id);
    });
  }

  async function getRawChatsWithRetry(
    attempts = 8,
    delayMs = 1500
  ): Promise<RawChat[]> {
    let lastError: unknown = null;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        return await getRawChats();
      } catch (err) {
        lastError = err;
        const messageText = err instanceof Error ? err.message : String(err);
        if (attempt === 1 || attempt === attempts) {
          console.warn(
            `No se pudieron cargar chats (intento ${attempt}/${attempts}): ${messageText}`
          );
        }
        if (attempt < attempts) {
          await delay(delayMs);
        }
      }
    }
    throw lastError instanceof Error
      ? lastError
      : new Error(String(lastError || "Error desconocido al cargar chats."));
  }

  async function listGroupNames(
    limit = 20
  ): Promise<{ total: number; names: string[] }> {
    const chats = await getRawChatsWithRetry();
    const groupNames = chats
      .filter((chat) => chat.isGroup)
      .map((chat) => chat.name)
      .filter((name) => name && name.trim().length > 0);
    const names = groupNames.slice(0, limit);
    return { total: groupNames.length, names };
  }

  async function findGroupByName(name: string): Promise<RawChat | null> {
    const chats = await getRawChatsWithRetry();
    const groups = chats.filter((chat) => chat.isGroup);
    const exact =
      groups.find((chat) => chat.name === name) || null;
    if (exact) {
      return exact;
    }
    const normalizedTarget = normalizeGroupName(name);
    const normalizedMatches = groups.filter(
      (chat) => normalizeGroupName(chat.name) === normalizedTarget
    );
    if (normalizedMatches.length === 1) {
      console.warn(
        `Nombre de grupo coincide por normalizacion. Usando '${normalizedMatches[0].name}'.`
      );
      return normalizedMatches[0];
    }
    if (normalizedMatches.length > 1) {
      console.error(
        `Se encontraron multiples grupos con nombre similar a '${name}'.`
      );
    }
    return null;
  }

  async function findGroupByNameWithRetry(
    name: string,
    attempts = 20,
    delayMs = 1500
  ): Promise<RawChat | null> {
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      const group = await findGroupByName(name);
      if (group) {
        return group;
      }
      if (attempt < attempts) {
        await delay(delayMs);
      }
    }
    return null;
  }

  function formatSender(contact: Contact): string {
    return contact.pushname || contact.name || contact.number || "Desconocido";
  }

  function normalizePhone(value: string | null | undefined): string | null {
    if (!value) {
      return null;
    }
    const digits = value.replace(/\D+/g, "");
    return digits || null;
  }

  function isLikelyMediaType(type: string | null | undefined): boolean {
    if (!type) {
      return false;
    }
    return ["image", "video", "audio", "ptt", "document", "sticker", "gif"].includes(
      type
    );
  }

  function shouldIgnoreMessageType(type: string | null | undefined): boolean {
    return type === "sticker";
  }

  function delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async function downloadMediaPayload(
    message: Message,
    attempts = 2,
    delayMs = 750
  ): Promise<MediaPayload | null> {
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        const media = await message.downloadMedia();
        if (media) {
          return {
            data: media.data,
            mimetype: media.mimetype,
            filename: media.filename || null,
          };
        }
      } catch (err) {
        const messageText = err instanceof Error ? err.message : String(err);
        console.warn(`No se pudo descargar media: ${messageText}`);
      }
      if (attempt < attempts - 1) {
        await delay(delayMs);
      }
    }
    return null;
  }

  function getMessageKey(message: Message): string {
    if (message.id && message.id._serialized) {
      return message.id._serialized;
    }
    const from = message.from || "";
    const to = message.to || "";
    const timestamp = message.timestamp || 0;
    const body = message.body || "";
    return `${from}_${to}_${timestamp}_${body}`;
  }

  function rememberOutgoingBody(body: string): void {
    const trimmed = body.trim();
    if (!trimmed) {
      return;
    }
    outgoingBodies.set(trimmed, Date.now() + 30_000);
  }

  function isOutgoingBody(body: string): boolean {
    const trimmed = body.trim();
    if (!trimmed) {
      return false;
    }
    const expiresAt = outgoingBodies.get(trimmed);
    if (!expiresAt) {
      return false;
    }
    if (expiresAt <= Date.now()) {
      outgoingBodies.delete(trimmed);
      return false;
    }
    return true;
  }

  function shouldProcessMessage(message: Message): boolean {
    const serializedId = message.id?._serialized;
    if (serializedId && ignoredMessageIds.has(serializedId)) {
      ignoredMessageIds.delete(serializedId);
      return false;
    }
    if (message.fromMe && isOutgoingBody(message.body || "")) {
      return false;
    }
    const key = getMessageKey(message);
    if (seenMessageIds.has(key)) {
      return false;
    }
    seenMessageIds.add(key);
    return true;
  }

  function getChatIdFromMessage(message: Message): string | null {
    if (message.fromMe) {
      return message.to || null;
    }
    return message.from || null;
  }

  function getSenderIdFromMessage(message: Message): string | null {
    if (message.author) {
      return message.author;
    }
    if (message.fromMe) {
      return selfId;
    }
    return message.from || null;
  }

  function normalizeContactId(senderId: string): string {
    const atIndex = senderId.indexOf("@");
    if (atIndex === -1) {
      return senderId;
    }
    const userPart = senderId.slice(0, atIndex);
    const domainPart = senderId.slice(atIndex + 1);
    const cleanedUser = userPart.split(":")[0];
    return `${cleanedUser}@${domainPart}`;
  }

  function extractNumber(senderId: string): string {
    const normalized = normalizeContactId(senderId);
    const atIndex = normalized.indexOf("@");
    const userPart = atIndex > 0 ? normalized.slice(0, atIndex) : normalized;
    const digits = userPart.replace(/\D+/g, "");
    return digits || userPart;
  }

  function isGroupId(senderId: string): boolean {
    return senderId.endsWith("@g.us");
  }

  async function getSenderInfo(
    senderId: string | null,
    fromMe: boolean
  ): Promise<{ label: string; number: string | null }> {
    if (!senderId) {
      return { label: "Desconocido", number: null };
    }
    const normalizedId = normalizeContactId(senderId);
    const cached = senderInfoCache.get(normalizedId);
    if (cached) {
      return cached;
    }
    const number = extractNumber(normalizedId);
    let resolvedNumber = normalizePhone(number) || number || null;
    if (fromMe && selfNumber) {
      resolvedNumber = selfNumber;
    }
    let label = resolvedNumber || normalizedId;
    if (isGroupId(normalizedId)) {
      label = "Sistema";
      const info = { label, number: null };
      senderInfoCache.set(normalizedId, info);
      return info;
    }
    try {
      const contact = await client.getContactById(normalizedId);
      const name = formatSender(contact);
      const contactNumber =
        normalizePhone(contact.number) || normalizePhone(contact.id?.user);
      if (contactNumber) {
        resolvedNumber = contactNumber;
      }
      if (name) {
        label =
          resolvedNumber && name !== resolvedNumber
            ? `${name} (${resolvedNumber})`
            : name;
      } else if (resolvedNumber) {
        label = resolvedNumber;
      }
    } catch {
      // ignore lookup failures and fall back to number
    }
    const info = { label, number: resolvedNumber };
    senderInfoCache.set(normalizedId, info);
    return info;
  }

  async function handleMessage(message: Message): Promise<void> {
    if (!activeGroupId) {
      return;
    }
    const chatId = getChatIdFromMessage(message);
    if (!chatId || chatId !== activeGroupId) {
      return;
    }
    if (!shouldProcessMessage(message)) {
      return;
    }
    if (shouldIgnoreMessageType(message.type)) {
      return;
    }

    const senderId = getSenderIdFromMessage(message);
    const senderInfo = await getSenderInfo(senderId, message.fromMe);
    const senderLabel = senderInfo.label;
    let body = message.body || "";
    const inferredHasMedia = message.hasMedia || isLikelyMediaType(message.type);
    if (!body) {
      if (inferredHasMedia) {
        body = `[media:${message.type}]`;
      } else if (message.type) {
        body = `[${message.type}]`;
      } else {
        body = "[mensaje sin texto]";
      }
    }
    const timestamp = new Date(message.timestamp * 1000);

    try {
      const senderNumber = senderInfo.number;
      const incoming: IncomingMessage = {
        body,
        timestamp,
        senderLabel,
        senderId,
        senderNumber,
        chatId,
        hasMedia: inferredHasMedia,
        mediaType: message.type || null,
        getMedia: async () => {
          if (!inferredHasMedia) {
            return null;
          }
          return downloadMediaPayload(message);
        },
        reply: async (text: string) => {
          try {
            rememberOutgoingBody(text);
            const sent = await client.sendMessage(chatId, text, {
              sendSeen: false,
            });
            const sentId = sent?.id?._serialized;
            if (sentId) {
              ignoredMessageIds.add(sentId);
            }
          } catch (err) {
            const messageText = err instanceof Error ? err.message : String(err);
            console.error(`No se pudo enviar respuesta: ${messageText}`);
          }
        },
        react: async (emoji: string) => {
          try {
            await message.react(emoji);
          } catch (err) {
            const messageText = err instanceof Error ? err.message : String(err);
            console.error(`No se pudo reaccionar al mensaje: ${messageText}`);
          }
        },
        sendPoll: async (
          title: string,
          options: string[],
          allowMultiple = false
        ) => {
          try {
            const poll = new Poll(title, options, {
              allowMultipleAnswers: allowMultiple,
              messageSecret: undefined,
            });
            const sent = await client.sendMessage(chatId, poll, {
              sendSeen: false,
            });
            const sentId = sent?.id?._serialized;
            if (sentId) {
              ignoredMessageIds.add(sentId);
            }
            return sentId ?? null;
          } catch (err) {
            const messageText = err instanceof Error ? err.message : String(err);
            console.error(`No se pudo enviar encuesta: ${messageText}`);
            return null;
          }
        },
      };
      await handler(incoming);
    } catch (err) {
      const messageText = err instanceof Error ? err.message : String(err);
      console.error(`Error al procesar mensaje: ${messageText}`);
    }
  }

  async function handlePollVote(vote: PollVote): Promise<void> {
    if (!pollVoteHandler || !activeGroupId) {
      return;
    }
    const parentMessage = vote.parentMessage;
    if (!parentMessage) {
      return;
    }
    const chatId = getChatIdFromMessage(parentMessage);
    if (!chatId || chatId !== activeGroupId) {
      return;
    }

    const senderId = vote.voter || null;
    const senderInfo = await getSenderInfo(senderId, senderId === selfId);
    const selectedOptionIds = vote.selectedOptions
      .map((option) => {
        const localId = (option as { localId?: number }).localId;
        return Number.isInteger(localId) ? localId : option.id;
      })
      .filter((value): value is number => Number.isInteger(value));
    const selectedOptionNames = vote.selectedOptions
      .map((option) => option.name)
      .filter((name): name is string => Boolean(name));
    if (selectedOptionIds.length === 0 && selectedOptionNames.length === 0) {
      return;
    }

    const pollMessageId = parentMessage.id?._serialized || null;
    const incomingVote: IncomingPollVote = {
      chatId,
      senderId,
      senderNumber: senderInfo.number,
      senderLabel: senderInfo.label,
      pollMessageId,
      selectedOptionIds,
      selectedOptionNames,
      timestamp: new Date(vote.interractedAtTs || Date.now()),
      reply: async (text: string) => {
        try {
          rememberOutgoingBody(text);
          const sent = await client.sendMessage(chatId, text, {
            sendSeen: false,
          });
          const sentId = sent?.id?._serialized;
          if (sentId) {
            ignoredMessageIds.add(sentId);
          }
        } catch (err) {
          const messageText = err instanceof Error ? err.message : String(err);
          console.error(`No se pudo enviar respuesta: ${messageText}`);
        }
      },
      sendPoll: async (
        title: string,
        options: string[],
        allowMultiple = false
      ) => {
        try {
          const poll = new Poll(title, options, {
            allowMultipleAnswers: allowMultiple,
            messageSecret: undefined,
          });
          const sent = await client.sendMessage(chatId, poll, {
            sendSeen: false,
          });
          const sentId = sent?.id?._serialized;
          if (sentId) {
            ignoredMessageIds.add(sentId);
          }
          return sentId ?? null;
        } catch (err) {
          const messageText = err instanceof Error ? err.message : String(err);
          console.error(`No se pudo enviar encuesta: ${messageText}`);
          return null;
        }
      },
    };
    await pollVoteHandler(incomingVote);
  }

  client.on("qr", (qr: string) => {
    console.log("Escanea este QR con WhatsApp para iniciar sesion.");
    qrcode.generate(qr, { small: true });
  });

  client.on("authenticated", () => {
    console.log("Autenticado.");
    readyHandled = false;
    conflictTakeoverAttempted = false;
    eventHooksReady = false;
    eventHookAttempts = 0;
    if (eventHookRetryTimer) {
      clearTimeout(eventHookRetryTimer);
      eventHookRetryTimer = null;
    }
    startReadyWatchdog();
  });

  client.on("auth_failure", (msg: string) => {
    console.error(`Fallo de autenticacion: ${msg}`);
  });

  client.on("change_state", (state: string) => {
    console.log(`Estado WA: ${state}`);
  });

  client.on("loading_screen", (percent: string, message: string) => {
    console.log(`Cargando: ${percent}% ${message}`);
  });

  async function isStoreReady(): Promise<boolean> {
    const page = (
      client as unknown as {
        pupPage?: {
          evaluate: (fn: () => boolean | Promise<boolean>) => Promise<boolean>;
        };
      }
    ).pupPage;
    if (!page?.evaluate) {
      return false;
    }
    try {
      return await page.evaluate(() => {
        const store = (window as unknown as {
          Store?: { Chat?: { getModelsArray?: () => unknown[] } };
        }).Store;
        return Boolean(store?.Chat?.getModelsArray);
      });
    } catch {
      return false;
    }
  }

  async function waitForStore(timeoutMs = 30000): Promise<void> {
    const page = (
      client as unknown as {
        pupPage?: {
          waitForFunction: (fn: string, options: { timeout: number }) => Promise<void>;
        };
      }
    ).pupPage;
    if (!page?.waitForFunction) {
      return;
    }
    try {
      await page.waitForFunction(
        "window.Store && window.Store.Chat && window.Store.Chat.getModelsArray",
        { timeout: timeoutMs }
      );
    } catch {
      // ignore and let retries handle it
    }
  }

  async function waitForStoreModules(timeoutMs = 60000): Promise<boolean> {
    const page = (
      client as unknown as {
        pupPage?: {
          waitForFunction: (fn: string, options: { timeout: number }) => Promise<void>;
        };
      }
    ).pupPage;
    if (!page?.waitForFunction) {
      return false;
    }
    try {
      await page.waitForFunction(
        "window.Store && window.Store.Msg && window.Store.Chat && window.Store.AppState && window.Store.Conn",
        { timeout: timeoutMs }
      );
      return true;
    } catch {
      return false;
    }
  }

  async function handleReady(trigger: string): Promise<void> {
    if (readyHandled || readyHandling) {
      return;
    }
    readyHandling = true;
    console.log("Sesion iniciada.");
    if (trigger !== "ready") {
      console.warn(`Ready por fallback (${trigger}).`);
    }
    readyHandled = true;
    stopReadyWatchdog();
    try {
      await waitForStore();
      await ensureEventHooks();
      const group = await findGroupByNameWithRetry(config.groupName);
      if (!group) {
        console.error(`No se encontro el grupo '${config.groupName}'.`);
        console.error("Verifica el nombre exacto en el archivo .env.");
        try {
          const { total, names } = await listGroupNames();
          if (total === 0) {
            console.error("No se encontraron grupos en esta cuenta.");
          } else {
            console.error(
              `Grupos encontrados (${total}). Algunos: ${names.join(", ")}`
            );
          }
        } catch (err) {
          const messageText = err instanceof Error ? err.message : String(err);
          console.error(`No se pudieron listar los grupos: ${messageText}`);
        }
        process.exit(1);
      }
      activeGroupId = group.id;
      const storedSelfId = client.info?.wid?._serialized ?? null;
      if (storedSelfId) {
        selfId = storedSelfId;
        selfNumber = normalizePhone(client.info?.wid?.user ?? null);
      } else {
        const fallbackSelf = await getSelfInfoFromStore();
        selfId = fallbackSelf?.id ?? null;
        selfNumber = fallbackSelf?.number ?? null;
      }
      console.log(
        `Escuchando mensajes entrantes del grupo: ${group.name || group.id}`
      );
    } catch (err) {
      const messageText = err instanceof Error ? err.message : String(err);
      console.error(`Error al buscar grupo: ${messageText}`);
      process.exit(1);
    } finally {
      readyHandling = false;
    }
  }

  client.on("ready", () => {
    if (readyHandled) {
      console.warn("Evento 'ready' duplicado. Se ignora.");
      return;
    }
    void handleReady("ready");
  });

  client.on("message", (message: Message) => {
    if (message.fromMe) {
      return;
    }
    void handleMessage(message);
  });

  client.on("message_create", (message: Message) => {
    if (!message.fromMe) {
      return;
    }
    void handleMessage(message);
  });

  if (pollVoteHandler) {
    client.on("vote_update", (vote: PollVote) => {
      void handlePollVote(vote);
    });
  }

  client.on("disconnected", (reason: string) => {
    console.log(`Cliente desconectado: ${reason}`);
    readyHandled = false;
    eventHooksReady = false;
    eventHookAttempts = 0;
    if (eventHookRetryTimer) {
      clearTimeout(eventHookRetryTimer);
      eventHookRetryTimer = null;
    }
    stopReadyWatchdog();
  });

  process.on("SIGINT", async () => {
    try {
      await client.destroy();
    } finally {
      process.exit(0);
    }
  });

  client.initialize();

  function stopReadyWatchdog(): void {
    if (readyWatchdog) {
      clearInterval(readyWatchdog);
      readyWatchdog = null;
    }
  }

  async function getStateSafe(): Promise<string | null> {
    try {
      return await client.getState();
    } catch {
      return null;
    }
  }

  async function forceTakeover(): Promise<void> {
    const page = (client as unknown as { pupPage?: { evaluate: (fn: () => void) => Promise<void> } })
      .pupPage;
    if (!page?.evaluate) {
      console.warn("No se pudo acceder al navegador para tomar control.");
      return;
    }
    try {
      await page.evaluate(() => {
        const store = (window as unknown as {
          Store?: { AppState?: { takeover?: () => void } };
        }).Store;
        if (store?.AppState?.takeover) {
          store.AppState.takeover();
        }
      });
      console.warn("Se envio solicitud de takeover a WhatsApp Web.");
    } catch (err) {
      const messageText = err instanceof Error ? err.message : String(err);
      console.warn(`No se pudo ejecutar takeover: ${messageText}`);
    }
  }

  async function ensureEventHooks(): Promise<void> {
    if (eventHooksReady) {
      return;
    }
    eventHookAttempts += 1;
    const internal = client as unknown as {
      pupPage?: {
        evaluate: (fn: () => unknown | Promise<unknown>) => Promise<unknown>;
      };
      attachEventListeners?: () => Promise<void>;
    };
    if (!internal.pupPage?.evaluate) {
      console.warn("No se pudo acceder al navegador para activar eventos.");
      return;
    }
    const storeReady = await waitForStoreModules();
    if (!storeReady) {
      console.warn("Store aun no esta listo para enganchar eventos.");
      scheduleEventHookRetry();
      return;
    }
    const hasWWebJS = await internal.pupPage.evaluate(() =>
      Boolean((window as unknown as { WWebJS?: unknown }).WWebJS)
    );
    if (!hasWWebJS) {
      try {
        const { LoadUtils } = require("whatsapp-web.js/src/util/Injected/Utils") as {
          LoadUtils: () => void;
        };
        await internal.pupPage.evaluate(LoadUtils);
      } catch (err) {
        const messageText = err instanceof Error ? err.message : String(err);
        console.warn(`No se pudo cargar WWebJS Utils: ${messageText}`);
      }
    }
    if (typeof internal.attachEventListeners === "function") {
      try {
        await internal.attachEventListeners();
        eventHooksReady = true;
        console.log("Hooks de eventos activados.");
      } catch (err) {
        const messageText = err instanceof Error ? err.message : String(err);
        console.warn(`No se pudieron activar eventos: ${messageText}`);
        scheduleEventHookRetry();
      }
    } else {
      console.warn("attachEventListeners no esta disponible en el cliente.");
    }
  }

  function scheduleEventHookRetry(): void {
    if (eventHooksReady || eventHookAttempts >= 5) {
      return;
    }
    if (eventHookRetryTimer) {
      clearTimeout(eventHookRetryTimer);
    }
    eventHookRetryTimer = setTimeout(() => {
      void ensureEventHooks();
    }, 5000);
  }

  async function getSelfInfoFromStore(): Promise<{ id: string; number: string | null } | null> {
    const page = (
      client as unknown as {
        pupPage?: {
          evaluate: <T>(fn: () => T | Promise<T>) => Promise<T>;
        };
      }
    ).pupPage;
    if (!page?.evaluate) {
      return null;
    }
    try {
      return await page.evaluate(() => {
        const store = (window as unknown as {
          Store?: {
            User?: {
              getMaybeMePnUser?: () => { _serialized?: string; user?: string } | null;
              getMaybeMeLidUser?: () => { _serialized?: string; user?: string } | null;
            };
          };
        }).Store;
        const wid =
          store?.User?.getMaybeMePnUser?.() ||
          store?.User?.getMaybeMeLidUser?.() ||
          null;
        if (!wid) {
          return null;
        }
        const id = wid._serialized || "";
        const number = wid.user || null;
        return id ? { id, number } : null;
      });
    } catch {
      return null;
    }
  }

  function startReadyWatchdog(): void {
    stopReadyWatchdog();
    readyStartedAt = Date.now();
    lastKnownState = null;
    readyWatchdog = setInterval(() => {
      if (watchdogRunning) {
        return;
      }
      watchdogRunning = true;
      void (async () => {
        try {
          if (readyHandled) {
            stopReadyWatchdog();
            return;
          }
          const state = await getStateSafe();
          if (state && state !== lastKnownState) {
            lastKnownState = state;
            console.log(`Estado WA (esperando ready): ${state}`);
          }
          if (!readyHandled && await isStoreReady()) {
            console.warn("Store detectado antes de 'ready'. Usando fallback.");
            await handleReady("store");
            return;
          }
          if (state === "CONFLICT" && !conflictTakeoverAttempted) {
            conflictTakeoverAttempted = true;
            console.warn("Conflicto detectado. Intentando tomar control...");
            await forceTakeover();
          }
          if (Date.now() - readyStartedAt > 120_000) {
            if (restartAttempts < 1) {
              restartAttempts += 1;
              console.error(
                "Tiempo de espera agotado esperando 'ready'. Reiniciando cliente..."
              );
              try {
                await client.destroy();
              } catch {
                // ignore destroy errors
              }
              await delay(2000);
              client.initialize();
              stopReadyWatchdog();
            } else {
              console.error(
                "Tiempo de espera agotado esperando 'ready'. Reinicia el proceso o borra la sesion."
              );
              stopReadyWatchdog();
            }
          }
        } finally {
          watchdogRunning = false;
        }
      })();
    }, 5000);
  }
}
