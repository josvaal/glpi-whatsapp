import qrcode from "qrcode-terminal";
import { Client, LocalAuth, Poll } from "whatsapp-web.js";
import type { Chat, Contact, Message, PollVote } from "whatsapp-web.js";

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

  const client = new Client({
    authStrategy: new LocalAuth({ dataPath: config.sessionDir }),
    puppeteer: puppeteerConfig,
  });

  let activeGroupId: string | null = null;
  let selfId: string | null = null;
  let selfNumber: string | null = null;
  const seenMessageIds = new Set<string>();
  const ignoredMessageIds = new Set<string>();
  const outgoingBodies = new Map<string, number>();
  const senderInfoCache = new Map<
    string,
    { label: string; number: string | null }
  >();

  async function findGroupByName(name: string): Promise<Chat | null> {
    const chats: Chat[] = await client.getChats();
    return chats.find((chat: Chat) => chat.isGroup && chat.name === name) || null;
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
  });

  client.on("auth_failure", (msg: string) => {
    console.error(`Fallo de autenticacion: ${msg}`);
  });

  client.on("ready", async () => {
    console.log("Sesion iniciada.");
    try {
      const group = await findGroupByName(config.groupName);
      if (!group) {
        console.error(`No se encontro el grupo '${config.groupName}'.`);
        console.error("Verifica el nombre exacto en el archivo .env.");
        process.exit(1);
      }
      activeGroupId = group.id._serialized;
      selfId = client.info?.wid?._serialized ?? null;
      selfNumber = normalizePhone(client.info?.wid?.user ?? null);
      console.log(`Escuchando mensajes entrantes del grupo: ${group.name}`);
    } catch (err) {
      const messageText = err instanceof Error ? err.message : String(err);
      console.error(`Error al buscar grupo: ${messageText}`);
      process.exit(1);
    }
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
  });

  process.on("SIGINT", async () => {
    try {
      await client.destroy();
    } finally {
      process.exit(0);
    }
  });

  client.initialize();
}
