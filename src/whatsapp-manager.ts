import makeWASocket, {
  DisconnectReason,
  fetchLatestBaileysVersion,
  useMultiFileAuthState,
  type WASocket,
  type WAConnectionState,
} from "@whiskeysockets/baileys";
import pino from "pino";
import qrcode from "qrcode-terminal";

import type { WhatsappConfig } from "./config";

export type WhatsAppState = {
  isConnected: boolean;
  isConnecting: boolean;
  qrCode: string | null;
  user: { id: string; name?: string } | null;
  error: string | null;
};

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
  private reconnectAttempts = 0;
  private readonly maxReconnectAttempts = 5;

  constructor(config: WhatsappConfig) {
    this.config = config;
  }

  setHandler(handler: WhatsAppEventHandler): void {
    this.handler = handler;
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
          console.log('📱 QR recibido, longitud:', qr.length);
          this.state.qrCode = qr;
          this.notifyQRCode(qr);
          this.notifyStateChange(); // ← Notificar cambio de estado para que el dashboard actualice el QR
          this.printQR(qr);
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
