import makeWASocket, {
  DisconnectReason,
  fetchLatestBaileysVersion,
  useMultiFileAuthState,
  type WASocket,
  type WAConnectionState,
  type WAMessage,
} from "@whiskeysockets/baileys";
import pino from "pino";
import qrcode from "qrcode-terminal";

import type { WhatsappConfig } from "./config";
import type { IncomingMessage } from "./types";

export type WhatsAppState = {
  isConnected: boolean;
  isConnecting: boolean;
  qrCode: string | null;
  user: { id: string; name?: string } | null;
  error: string | null;
};

export type MessageHandler = (message: IncomingMessage) => Promise<void>;

export type WhatsAppEventHandler = {
  onStateChange?: (state: WhatsAppState) => void;
  onQRCode?: (qr: string) => void;
  onConnected?: () => void;
  onDisconnected?: () => void;
};

export class WhatsAppManager {
  private config: WhatsappConfig;
  private socket: WASocket | null = null;
  private state: WhatsAppState = {
    isConnected: false,
    isConnecting: false,
    qrCode: null,
    user: null,
    error: null,
  };
  private handler: WhatsAppEventHandler | null = null;
  private messageHandler: MessageHandler | null = null;
  private activeGroupId: string | null = null;
  private selfId: string | null = null;
  private reconnectAttempts = 0;
  private readonly maxReconnectAttempts = 5;

  constructor(config: WhatsappConfig) {
    this.config = config;
  }

  setHandler(handler: WhatsAppEventHandler): void {
    this.handler = handler;
  }

  setMessageHandler(handler: MessageHandler): void {
    this.messageHandler = handler;
  }

  getState(): WhatsAppState {
    return { ...this.state };
  }

  async initialize(): Promise<void> {
    await this.connect();
  }

  private async connect(): Promise<void> {
    if (this.state.isConnecting) {
      return;
    }

    this.state.isConnecting = true;
    this.state.error = null;
    this.notifyStateChange();

    try {
      const { state: authState, saveCreds } = await useMultiFileAuthState(
        this.config.sessionDir
      );

      const logger = pino({ level: "silent" });

      let version: [number, number, number] | undefined;
      try {
        const latest = await fetchLatestBaileysVersion();
        version = latest.version;
      } catch {
        // ignore
      }

      this.socket = makeWASocket({
        version,
        auth: authState,
        printQRInTerminal: false,
        syncFullHistory: false,
        markOnlineOnConnect: false,
        generateHighQualityLinkPreview: false,
        logger,
      });

      this.socket.ev.on("creds.update", saveCreds);

      this.socket.ev.on("connection.update", async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
          // Solo notificar QR si no está conectado
          if (!this.state.isConnected) {
            console.log('📱 QR recibido, longitud:', qr.length);
            this.state.qrCode = qr;
            this.notifyQRCode(qr);
            this.notifyStateChange();
            this.printQR(qr);
          }
        }

        if (connection === "open") {
          console.log("✅ WhatsApp conectado");
          this.state.isConnected = true;
          this.state.isConnecting = false;
          this.state.qrCode = null;
          this.state.error = null;
          this.state.user = {
            id: this.socket?.user?.id ?? "",
            name: this.socket?.user?.name,
          };
          this.reconnectAttempts = 0;
          this.notifyConnected();
          this.notifyStateChange();

          // Encontrar el grupo y configurar listener de mensajes
          this.activeGroupId = await this.findGroupByNameWithRetry(this.config.groupName);
          if (this.activeGroupId) {
            console.log(`👥 Grupo encontrado: ${this.config.groupName} (${this.activeGroupId})`);
            this.setupMessageListener();
          } else {
            console.error(`❌ No se encontró el grupo '${this.config.groupName}'`);
          }
        } else if (connection === "close") {
          const statusCode =
            (lastDisconnect?.error as { output?: { statusCode?: number } })
              ?.output?.statusCode ?? null;

          console.log(`🔌 WhatsApp desconectado: ${statusCode ?? "desconocido"}`);

          this.state.isConnected = false;
          this.state.isConnecting = false;
          this.notifyDisconnected();
          this.notifyStateChange();

          // Reconnect logic
          const shouldReconnect =
            statusCode !== DisconnectReason.loggedOut &&
            this.reconnectAttempts < this.maxReconnectAttempts;

          if (shouldReconnect) {
            this.reconnectAttempts++;
            console.log(`🔄 Reintentando conexión (${this.reconnectAttempts}/${this.maxReconnectAttempts})...`);
            setTimeout(() => this.connect(), 2000);
          } else if (statusCode === DisconnectReason.loggedOut) {
            this.state.error = "Sesión cerrada. Escanea QR nuevamente.";
            console.error("❌ Sesión de WhatsApp cerrada. Escanea QR nuevamente.");
            // Limpiar sesión y reconectar para generar nuevo QR
            this.state.isConnected = false;
            this.state.isConnecting = false;
            this.state.qrCode = null;
            this.state.user = null;
            this.reconnectAttempts = 0;
            this.notifyStateChange();
            // Reconectar después de un momento para generar nuevo QR
            setTimeout(() => {
              console.log('🔄 Generando nuevo código QR...');
              this.connect();
            }, 3000);
          } else {
            this.state.error = "No se pudo conectar. Reinicia el bot.";
            console.error("❌ No se pudo conectar a WhatsApp");
            this.notifyStateChange();
          }
        }
      });

      this.socket.ev.on("contacts.upsert", () => {
        // Update user info if available
        if (this.socket?.user) {
          this.state.user = {
            id: this.socket.user.id,
            name: this.socket.user.name,
          };
          this.notifyStateChange();
        }
      });
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      console.error("❌ Error al conectar WhatsApp:", error);
      this.state.error = error;
      this.state.isConnecting = false;
      this.notifyStateChange();
    }
  }

  async logout(): Promise<void> {
    if (this.socket) {
      this.socket.end(undefined);
      this.socket = null;
    }
    this.state.isConnected = false;
    this.state.isConnecting = false;
    this.state.qrCode = null;
    this.state.user = null;
    this.state.error = null;
    this.reconnectAttempts = 0;
    this.notifyStateChange();
    console.log("🚪 WhatsApp logout completado");
  }

  private async findGroupByNameWithRetry(
    name: string,
    attempts = 10,
    delayMs = 1500
  ): Promise<string | null> {
    if (!this.socket) {
      return null;
    }
    const normalizedTarget = name.trim().replace(/\s+/g, " ").toLowerCase();
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        const groups = await this.socket.groupFetchAllParticipating();
        const exact = Object.values(groups).find((group) => group.subject === name);
        if (exact) {
          return exact.id;
        }
        const normalized = Object.values(groups).filter(
          (group) => (group.subject || "").trim().replace(/\s+/g, " ").toLowerCase() === normalizedTarget
        );
        if (normalized.length === 1) {
          console.warn(`Nombre de grupo coincide por normalizacion. Usando '${normalized[0].subject}'.`);
          return normalized[0].id;
        }
      } catch {
        // ignore
      }
      if (attempt < attempts) {
        await new Promise(resolve => setTimeout(resolve, delayMs));
      }
    }
    return null;
  }

  private setupMessageListener(): void {
    if (!this.socket || !this.activeGroupId || !this.messageHandler) {
      return;
    }

    const seenMessageIds = new Set<string>();
    const ignoredMessageIds = new Set<string>();
    const outgoingBodies = new Map<string, number>();

    console.log(`👂 Escuchando mensajes del grupo: ${this.activeGroupId}`);

    this.socket.ev.on("messages.upsert", async (upsert) => {
      if (!this.socket || !this.activeGroupId) {
        return;
      }

      for (const msg of upsert.messages) {
        if (!msg.message) {
          continue;
        }

        const chatId = msg.key.remoteJid || "";
        if (chatId !== this.activeGroupId) {
          continue;
        }

        // Ignorar mensajes salientes
        const id = msg.key.id || "";
        if (ignoredMessageIds.has(id)) {
          ignoredMessageIds.delete(id);
          continue;
        }

        if (msg.key.fromMe) {
          const text = msg.message.conversation || msg.message.extendedTextMessage?.text || "";
          if (text) {
            outgoingBodies.set(text.trim(), Date.now() + 30000);
          }
          continue;
        }

        // Ignorar mensajes duplicados
        const key = `${chatId}_${id}`;
        if (seenMessageIds.has(key)) {
          continue;
        }
        seenMessageIds.add(key);

        // Extraer contenido del mensaje
        const content = msg.message.conversation || msg.message.extendedTextMessage?.text || "";
        const hasMedia = !!(msg.message.imageMessage || msg.message.videoMessage || msg.message.documentMessage);
        const mediaType = msg.message.imageMessage ? "image" : msg.message.videoMessage ? "video" : msg.message.documentMessage ? "document" : null;

        if (!content && !hasMedia) {
          continue;
        }

        const senderId = msg.key.participant || msg.key.remoteJid || "";
        const senderNumber = senderId.replace(/\D/g, "").split("@")[0];
        const senderLabel = msg.pushName || senderNumber || "Desconocido";
        const timestamp = new Date((Number(msg.messageTimestamp) || 0) * 1000);

        const incoming: IncomingMessage = {
          body: content || `[media:${mediaType || "desconocido"}]`,
          timestamp,
          senderLabel,
          senderId,
          senderNumber,
          chatId,
          hasMedia,
          mediaType,
          getMedia: async () => null, // Implementar si es necesario
          reply: async (text: string) => {
            if (!this.socket) return;
            ignoredMessageIds.add(id);
            const sent = await this.socket.sendMessage(chatId, { text });
            if (sent?.key?.id) {
              ignoredMessageIds.add(sent.key.id);
            }
          },
          react: async (emoji: string) => {
            if (!this.socket) return;
            await this.socket.sendMessage(chatId, {
              react: { text: emoji, key: msg.key },
            });
          },
          sendPoll: async (title: string, options: string[], allowMultiple = false) => {
            if (!this.socket) return null;
            const sent = await this.socket.sendMessage(chatId, {
              poll: {
                name: title,
                values: options,
                selectableCount: allowMultiple ? 0 : 1,
              },
            });
            return sent?.key?.id || null;
          },
        };

        try {
          await this.messageHandler!(incoming);
        } catch (err) {
          const messageText = err instanceof Error ? err.message : String(err);
          console.error(`❌ Error al procesar mensaje: ${messageText}`);
        }
      }
    });
  }

  getSocket(): WASocket | null {
    return this.socket;
  }

  private notifyStateChange(): void {
    this.handler?.onStateChange?.(this.state);
  }

  private notifyQRCode(qr: string): void {
    this.handler?.onQRCode?.(qr);
  }

  private notifyConnected(): void {
    this.handler?.onConnected?.();
  }

  private notifyDisconnected(): void {
    this.handler?.onDisconnected?.();
  }

  private printQR(qr: string): void {
    console.log("📱 Escanea este QR con WhatsApp:");
    qrcode.generate(qr, { small: true });
  }
}
