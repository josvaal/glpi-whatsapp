import qrcode from "qrcode-terminal";
import { Client, LocalAuth } from "whatsapp-web.js";
import type { Chat, Contact, Message } from "whatsapp-web.js";

import type { WhatsappConfig } from "./config";
import type { IncomingMessage, MediaPayload } from "./types";

export type MessageHandler = (message: IncomingMessage) => Promise<void>;

export function startWhatsAppListener(
  config: WhatsappConfig,
  handler: MessageHandler
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
  const seenMessageIds = new Set<string>();
  const senderLabelCache = new Map<string, string>();

  async function findGroupByName(name: string): Promise<Chat | null> {
    const chats: Chat[] = await client.getChats();
    return chats.find((chat: Chat) => chat.isGroup && chat.name === name) || null;
  }

  function formatSender(contact: Contact): string {
    return contact.pushname || contact.name || contact.number || "Desconocido";
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

  function shouldProcessMessage(message: Message): boolean {
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

  async function getSenderLabel(senderId: string | null): Promise<string> {
    if (!senderId) {
      return "Desconocido";
    }
    const normalizedId = normalizeContactId(senderId);
    const cached = senderLabelCache.get(normalizedId);
    if (cached) {
      return cached;
    }
    const number = extractNumber(normalizedId);
    let label = number || normalizedId;
    if (isGroupId(normalizedId)) {
      label = "Sistema";
      senderLabelCache.set(normalizedId, label);
      return label;
    }
    try {
      const contact = await client.getContactById(normalizedId);
      const name = formatSender(contact);
      if (name && name !== number) {
        label = `${name} (${number})`;
      }
    } catch {
      // ignore lookup failures and fall back to number
    }
    senderLabelCache.set(normalizedId, label);
    return label;
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

    const senderId = getSenderIdFromMessage(message);
    const senderLabel = await getSenderLabel(senderId);
    let body = message.body || "";
    if (!body) {
      if (message.hasMedia) {
        body = `[media:${message.type}]`;
      } else if (message.type) {
        body = `[${message.type}]`;
      } else {
        body = "[mensaje sin texto]";
      }
    }
    const timestamp = new Date(message.timestamp * 1000);

    try {
      const senderNumber = senderId ? extractNumber(senderId) : null;
      const incoming: IncomingMessage = {
        body,
        timestamp,
        senderLabel,
        senderId,
        senderNumber,
        chatId,
        hasMedia: message.hasMedia,
        mediaType: message.type || null,
        getMedia: async () => {
          if (!message.hasMedia) {
            return null;
          }
          const media = await message.downloadMedia();
          if (!media) {
            return null;
          }
          const payload: MediaPayload = {
            data: media.data,
            mimetype: media.mimetype,
            filename: media.filename || null,
          };
          return payload;
        },
        reply: async (text: string) => {
          await message.reply(text);
        },
      };
      await handler(incoming);
    } catch (err) {
      const messageText = err instanceof Error ? err.message : String(err);
      console.error(`Error al procesar mensaje: ${messageText}`);
    }
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
      console.log(`Escuchando mensajes entrantes del grupo: ${group.name}`);
    } catch (err) {
      const messageText = err instanceof Error ? err.message : String(err);
      console.error(`Error al buscar grupo: ${messageText}`);
      process.exit(1);
    }
  });

  client.on("message", (message: Message) => {
    void handleMessage(message);
  });

  client.on("message_create", (message: Message) => {
    void handleMessage(message);
  });

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
