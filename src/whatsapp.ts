import qrcode from "qrcode-terminal";
import makeWASocket, {
  DisconnectReason,
  downloadContentFromMessage,
  fetchLatestBaileysVersion,
  getContentType,
  jidNormalizedUser,
  proto,
  useMultiFileAuthState,
  type WAMessage,
  type WASocket,
} from "@whiskeysockets/baileys";
import pino from "pino";

import type { WhatsappConfig } from "./config";
import type { IncomingMessage, IncomingPollVote, MediaPayload } from "./types";

export type MessageHandler = (message: IncomingMessage) => Promise<void>;
export type PollVoteHandler = (vote: IncomingPollVote) => Promise<void>;

type RawGroup = { id: string; name: string };
type MediaContent =
  | proto.Message.IImageMessage
  | proto.Message.IVideoMessage
  | proto.Message.IAudioMessage
  | proto.Message.IDocumentMessage;

export function startWhatsAppListener(
  config: WhatsappConfig,
  handler: MessageHandler,
  pollVoteHandler?: PollVoteHandler
): void {
  void start(config, handler, pollVoteHandler);
}

async function start(
  config: WhatsappConfig,
  handler: MessageHandler,
  pollVoteHandler?: PollVoteHandler
): Promise<void> {
  const { state, saveCreds } = await useMultiFileAuthState(config.sessionDir);
  const logger = pino({ level: "silent" });
  let activeGroupId: string | null = null;
  let selfId: string | null = null;
  let selfNumber: string | null = null;
  const seenMessageIds = new Set<string>();
  const ignoredMessageIds = new Set<string>();
  const outgoingBodies = new Map<string, number>();

  let sock: WASocket | null = null;
  let reconnecting = false;

  async function connect(): Promise<void> {
    if (reconnecting) {
      return;
    }
    reconnecting = true;

    let version: [number, number, number] | undefined;
    try {
      const latest = await fetchLatestBaileysVersion();
      version = latest.version;
    } catch {
      // ignore and let baileys pick a default
    }

    sock = makeWASocket({
      version,
      auth: state,
      printQRInTerminal: false,
      syncFullHistory: false,
      markOnlineOnConnect: false,
      generateHighQualityLinkPreview: false,
      logger,
    });

    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("connection.update", async (update) => {
      const { connection, lastDisconnect, qr } = update;
      if (qr) {
        console.log("Escanea este QR con WhatsApp para iniciar sesion.");
        qrcode.generate(qr, { small: true });
      }

      if (connection === "open") {
        console.log("Autenticado.");
        console.log("Sesion iniciada.");
        selfId = sock?.user?.id ?? null;
        selfNumber = normalizePhone(selfId ? extractNumber(selfId) : null);
        activeGroupId = await findGroupByNameWithRetry(sock, config.groupName);
        if (!activeGroupId) {
          console.error(`No se encontro el grupo '${config.groupName}'.`);
          console.error("Verifica el nombre exacto en el archivo .env.");
          const groups = await listGroupsSafe(sock);
          if (groups.length > 0) {
            console.error(
              `Grupos encontrados (${groups.length}). Algunos: ${groups
                .slice(0, 20)
                .map((g) => g.name)
                .join(", ")}`
            );
          }
          process.exit(1);
        }
        console.log(
          `Escuchando mensajes entrantes del grupo: ${await resolveGroupName(
            sock,
            activeGroupId
          )}`
        );
      } else if (connection === "close") {
        const statusCode =
          (lastDisconnect?.error as { output?: { statusCode?: number } })
            ?.output?.statusCode ?? null;
        console.log(
          `Cliente desconectado: ${statusCode ?? "desconocido"}`
        );
        if (statusCode !== DisconnectReason.loggedOut) {
          setTimeout(() => {
            reconnecting = false;
            void connect();
          }, 2000);
        }
      }
    });

    sock.ev.on("messages.upsert", async (upsert) => {
      if (!sock || !activeGroupId) {
        return;
      }
      for (const msg of upsert.messages) {
        if (!msg.message) {
          continue;
        }
        const chatId = msg.key.remoteJid || "";
        if (chatId !== activeGroupId) {
          continue;
        }
        if (!shouldProcessMessage(msg, ignoredMessageIds, outgoingBodies, seenMessageIds)) {
          continue;
        }

        const content = unwrapMessage(msg.message);
        if (!content) {
          continue;
        }
        const summary = summarizeMessage(content);
        if (summary.isSticker) {
          continue;
        }

        const senderId = getSenderId(msg, selfId);
        const senderNumber = normalizePhone(senderId ? extractNumber(senderId) : null);
        const senderLabel = msg.pushName || senderNumber || "Desconocido";
        const timestamp = new Date(getTimestampSeconds(msg) * 1000);
        const body = summary.text || buildFallbackBody(summary);

        const incoming: IncomingMessage = {
          body,
          timestamp,
          senderLabel,
          senderId,
          senderNumber,
          chatId,
          hasMedia: summary.hasMedia,
          mediaType: summary.mediaType,
          getMedia: async () => {
            if (!summary.hasMedia) {
              return null;
            }
            return downloadMediaPayload(content);
          },
          reply: async (text: string) => {
            if (!sock) {
              return;
            }
            rememberOutgoingBody(outgoingBodies, text);
            const sent = await sock.sendMessage(chatId, { text });
            const sentId = sent?.key?.id;
            if (sentId) {
              ignoredMessageIds.add(sentId);
            }
          },
          react: async (emoji: string) => {
            if (!sock) {
              return;
            }
            await sock.sendMessage(chatId, {
              react: { text: emoji, key: msg.key },
            });
          },
          sendPoll: async (
            title: string,
            options: string[],
            allowMultiple = false
          ) => {
            if (!sock) {
              return null;
            }
            const sent = await sock.sendMessage(chatId, {
              poll: {
                name: title,
                values: options,
                selectableCount: allowMultiple ? 0 : 1,
              },
            });
            const sentId = sent?.key?.id;
            if (sentId) {
              ignoredMessageIds.add(sentId);
            }
            return sentId ?? null;
          },
        };

        try {
          await handler(incoming);
        } catch (err) {
          const messageText = err instanceof Error ? err.message : String(err);
          console.error(`Error al procesar mensaje: ${messageText}`);
        }
      }
    });

    sock.ev.on("messages.update", async (updates) => {
      if (!pollVoteHandler || !sock || !activeGroupId) {
        return;
      }
      for (const update of updates) {
        const msg = update.update?.message;
        if (!msg) {
          continue;
        }
        const content = unwrapMessage(msg);
        if (!content?.pollUpdateMessage) {
          continue;
        }
        // Baileys necesita helpers de poll para decodificar votos; por ahora omitimos.
      }
    });

    reconnecting = false;
  }

  await connect();
}

function normalizeGroupName(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLowerCase();
}

async function listGroupsSafe(sock: WASocket | null): Promise<RawGroup[]> {
  if (!sock) {
    return [];
  }
  try {
    const groups = await sock.groupFetchAllParticipating();
    return Object.values(groups).map((group) => ({
      id: group.id,
      name: group.subject || group.id,
    }));
  } catch {
    return [];
  }
}

async function findGroupByNameWithRetry(
  sock: WASocket | null,
  name: string,
  attempts = 10,
  delayMs = 1500
): Promise<string | null> {
  if (!sock) {
    return null;
  }
  const normalizedTarget = normalizeGroupName(name);
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const groups = await listGroupsSafe(sock);
      const exact = groups.find((group) => group.name === name);
      if (exact) {
        return exact.id;
      }
      const normalized = groups.filter(
        (group) => normalizeGroupName(group.name) === normalizedTarget
      );
      if (normalized.length === 1) {
        console.warn(
          `Nombre de grupo coincide por normalizacion. Usando '${normalized[0].name}'.`
        );
        return normalized[0].id;
      }
    } catch {
      // ignore
    }
    if (attempt < attempts) {
      await delay(delayMs);
    }
  }
  return null;
}

async function resolveGroupName(sock: WASocket | null, id: string): Promise<string> {
  if (!sock) {
    return id;
  }
  try {
    const groups = await listGroupsSafe(sock);
    const match = groups.find((group) => group.id === id);
    return match?.name || id;
  } catch {
    return id;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getSenderId(msg: WAMessage, selfId: string | null): string | null {
  if (msg.key.fromMe) {
    return selfId;
  }
  const participant =
    msg.key.participant || (msg as { participant?: string }).participant;
  return participant || msg.key.remoteJid || null;
}

function extractNumber(jid: string): string {
  const normalized = jidNormalizedUser(jid);
  const atIndex = normalized.indexOf("@");
  const userPart = atIndex > 0 ? normalized.slice(0, atIndex) : normalized;
  const digits = userPart.replace(/\D+/g, "");
  return digits || userPart;
}

function normalizePhone(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }
  const digits = value.replace(/\D+/g, "");
  return digits || null;
}

function rememberOutgoingBody(outgoingBodies: Map<string, number>, body: string): void {
  const trimmed = body.trim();
  if (!trimmed) {
    return;
  }
  outgoingBodies.set(trimmed, Date.now() + 30_000);
}

function isOutgoingBody(outgoingBodies: Map<string, number>, body: string): boolean {
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

function shouldProcessMessage(
  msg: WAMessage,
  ignoredMessageIds: Set<string>,
  outgoingBodies: Map<string, number>,
  seenMessageIds: Set<string>
): boolean {
  const id = msg.key.id || "";
  if (id && ignoredMessageIds.has(id)) {
    ignoredMessageIds.delete(id);
    return false;
  }
  if (msg.key.fromMe && msg.message) {
    const content = unwrapMessage(msg.message);
    const text = content ? summarizeMessage(content).text : "";
    if (text && isOutgoingBody(outgoingBodies, text)) {
      return false;
    }
  }
  const key = `${msg.key.remoteJid || ""}_${id}`;
  if (seenMessageIds.has(key)) {
    return false;
  }
  seenMessageIds.add(key);
  return true;
}

function getTimestampSeconds(msg: WAMessage): number {
  const ts = msg.messageTimestamp;
  if (typeof ts === "number") {
    return ts;
  }
  if (ts && typeof ts === "object" && "toNumber" in ts) {
    return (ts as { toNumber: () => number }).toNumber();
  }
  return Math.floor(Date.now() / 1000);
}

function unwrapMessage(message: proto.IMessage | null | undefined): proto.IMessage | null {
  if (!message) {
    return null;
  }
  if (message.ephemeralMessage?.message) {
    return unwrapMessage(message.ephemeralMessage.message);
  }
  if (message.viewOnceMessage?.message) {
    return unwrapMessage(message.viewOnceMessage.message);
  }
  if (message.viewOnceMessageV2?.message) {
    return unwrapMessage(message.viewOnceMessageV2.message);
  }
  if (message.documentWithCaptionMessage?.message) {
    return unwrapMessage(message.documentWithCaptionMessage.message);
  }
  if (message.editedMessage?.message) {
    return unwrapMessage(message.editedMessage.message);
  }
  return message;
}

function summarizeMessage(message: proto.IMessage): {
  text: string;
  hasMedia: boolean;
  mediaType: string | null;
  isSticker: boolean;
} {
  const type = getContentType(message);
  if (!type) {
    return { text: "", hasMedia: false, mediaType: null, isSticker: false };
  }

  switch (type) {
    case "conversation":
      return { text: message.conversation || "", hasMedia: false, mediaType: null, isSticker: false };
    case "extendedTextMessage":
      return { text: message.extendedTextMessage?.text || "", hasMedia: false, mediaType: null, isSticker: false };
    case "imageMessage":
      return { text: message.imageMessage?.caption || "", hasMedia: true, mediaType: "image", isSticker: false };
    case "videoMessage":
      return { text: message.videoMessage?.caption || "", hasMedia: true, mediaType: "video", isSticker: false };
    case "audioMessage":
      return {
        text: "",
        hasMedia: true,
        mediaType: message.audioMessage?.ptt ? "ptt" : "audio",
        isSticker: false,
      };
    case "documentMessage":
      return { text: message.documentMessage?.caption || "", hasMedia: true, mediaType: "document", isSticker: false };
    case "stickerMessage":
      return { text: "", hasMedia: true, mediaType: "sticker", isSticker: true };
    default:
      return { text: "", hasMedia: false, mediaType: type, isSticker: false };
  }
}

function buildFallbackBody(summary: {
  hasMedia: boolean;
  mediaType: string | null;
}): string {
  if (summary.hasMedia) {
    return `[media:${summary.mediaType || "desconocido"}]`;
  }
  if (summary.mediaType) {
    return `[${summary.mediaType}]`;
  }
  return "[mensaje sin texto]";
}

async function downloadMediaPayload(message: proto.IMessage): Promise<MediaPayload | null> {
  if (message.imageMessage) {
    return downloadFromMessage(message.imageMessage, "image");
  }
  if (message.videoMessage) {
    return downloadFromMessage(message.videoMessage, "video");
  }
  if (message.audioMessage) {
    return downloadFromMessage(message.audioMessage, "audio");
  }
  if (message.documentMessage) {
    return downloadFromMessage(message.documentMessage, "document");
  }
  return null;
}

async function downloadFromMessage(
  content: MediaContent,
  type: "image" | "video" | "audio" | "document"
): Promise<MediaPayload | null> {
  try {
    const stream = await downloadContentFromMessage(content, type);
    const chunks: Buffer[] = [];
    for await (const chunk of stream) {
      chunks.push(Buffer.from(chunk));
    }
    const buffer = Buffer.concat(chunks);
    const mimetype = (content as { mimetype?: string }).mimetype || "application/octet-stream";
    const filename = (content as { fileName?: string }).fileName || null;
    return {
      data: buffer.toString("base64"),
      mimetype,
      filename,
    };
  } catch {
    return null;
  }
}
