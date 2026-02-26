/**
 * WhatsAppManager - Implementación usando Playwright
 */

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

export type IncomingMessage = {
  body: string;
  timestamp: Date;
  senderLabel: string;
  senderId: string | null;
  senderNumber: string | null;
  chatId: string;
  hasMedia: boolean;
  mediaType: string | null;
  getMedia: () => Promise<MediaPayload | null>;
  reply: (text: string) => Promise<void>;
  react: (emoji: string) => Promise<void>;
  sendPoll: (
    title: string,
    options: string[],
    allowMultiple?: boolean
  ) => Promise<string | null>;
};

export type MediaPayload = {
  data: string;
  mimetype: string;
  filename: string | null;
};

import { WhatsAppPlaywrightManager } from "./whatsapp-playwright";
import type { WhatsappConfig } from "./config";

/**
 * WhatsAppManager - Wrapper que usa Playwright internamente
 */
export class WhatsAppManager {
  private playwrightManager: WhatsAppPlaywrightManager;

  constructor(config: WhatsappConfig) {
    this.playwrightManager = new WhatsAppPlaywrightManager(config);
  }

  setHandler(handler: WhatsAppEventHandler): void {
    this.playwrightManager.setHandler(handler);
  }

  setMessageHandler(handler: MessageHandler): void {
    this.playwrightManager.setMessageHandler(handler);
  }

  getState(): WhatsAppState {
    return this.playwrightManager.getState();
  }

  async initialize(): Promise<void> {
    return this.playwrightManager.initialize();
  }

  async logout(): Promise<void> {
    return this.playwrightManager.logout();
  }

  /**
   * Método para compatibilidad - devuelve un objeto simulado del socket
   * Nota: Playwright no expone el socket interno de la misma forma
   */
  getSocket(): unknown {
    return {
      user: this.playwrightManager.getState().user,
    };
  }

  /**
   * Devuelve el ID del grupo activo
   */
  getActiveGroupId(): string | null {
    return this.playwrightManager.getActiveGroupId();
  }
}
