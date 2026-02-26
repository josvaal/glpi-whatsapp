import {
  chromium,
  type Browser,
  type BrowserContext,
  type Page,
  type Locator,
} from "playwright";
import qrcode from "qrcode-terminal";
import fs from "fs";
import path from "path";

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

/**
 * WhatsAppPlaywrightManager - Usa Playwright para automatizar WhatsApp Web
 */
export class WhatsAppPlaywrightManager {
  private config: WhatsappConfig;
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private page: Page | null = null;
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
  private seenMessageIds = new Set<string>();
  private reconnectAttempts = 0;
  private readonly maxReconnectAttempts = 5;
  private pollInterval: NodeJS.Timeout | null = null;
  private checkQRInterval: NodeJS.Timeout | null = null;
  private isShuttingDown = false;
  private lastProcessedMessageCount = 0;

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

  /**
   * Extrae el número de teléfono de un ID de WhatsApp
   */
  private extractNumberFromId(id: string): string | null {
    try {
      const atIndex = id.indexOf("@");
      const userPart = atIndex > 0 ? id.slice(0, atIndex) : id;
      const digits = userPart.replace(/\D+/g, "");
      return digits.length >= 10 ? digits : null;
    } catch {
      return null;
    }
  }

  /**
   * Extrae el groupId de la URL de WhatsApp Web
   */
  private extractGroupIdFromUrl(url: string): string | null {
    try {
      // URL format: https://web.whatsapp.com/ or https://web.whatsapp.com/?type=phone&number=...
      // Group URL: https://web.whatsapp.com/?tab=chat&jid=...@g.us
      const match = url.match(/jid=([^&]+)/);
      if (match) {
        return decodeURIComponent(match[1]);
      }
      // Alternative format
      const altMatch = url.match(/\/chat\/([0-9@]+)/);
      if (altMatch) {
        return altMatch[1];
      }
      return null;
    } catch {
      return null;
    }
  }

  /**
   * Genera el ID de chat de WhatsApp Web desde el ID del grupo
   */
  private getChatJid(groupId: string): string {
    // Si ya tiene el formato correcto, devolverlo
    if (groupId.includes("@")) {
      return groupId;
    }
    // Agregar el sufijo de grupo
    return `${groupId}@g.us`;
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

    console.log("📱 Iniciando Playwright...");

    try {
      // Browser args para headless en Linux
      const args: string[] = [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-accelerated-2d-canvas",
        "--disable-gpu",
      ];

      this.browser = await chromium.launch({
        headless: this.config.headless,
        args,
        channel: undefined, // Usa el chromium descargado por playwright
      });

      console.log("📱 Navegando a WhatsApp Web...");

      // Crear contexto con almacenamiento de sesión
      const sessionPath = path.join(this.config.sessionDir, "playwright-state.json");
      let storageState: string | undefined = undefined;

      if (fs.existsSync(sessionPath)) {
        try {
          storageState = fs.readFileSync(sessionPath, "utf-8");
          console.log("📱 Cargando sesión guardada...");
        } catch {
          console.log("⚠️ No se pudo cargar la sesión guardada");
        }
      }

      this.context = await this.browser.newContext({
        storageState: storageState as any,
        viewport: { width: 1280, height: 720 },
        userAgent: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      });

      this.page = await this.context.newPage();
      this.page.setDefaultTimeout(30000);

      // Navegar a WhatsApp Web
      await this.page.goto("https://web.whatsapp.com", {
        waitUntil: "domcontentloaded",
      });

      console.log("📱 Esperando pantalla de login...");

      // Esperar y procesar QR code o conexión
      await this.handleQROrLogin();

      // Si llegamos aquí, estamos conectados
      this.state.isConnected = true;
      this.state.isConnecting = false;
      this.state.qrCode = null;
      this.reconnectAttempts = 0;
      this.notifyConnected();
      this.notifyStateChange();

      console.log("✅ Conectado a WhatsApp");

      // Guardar estado de sesión
      if (fs.existsSync(this.config.sessionDir) || fs.mkdirSync(this.config.sessionDir, { recursive: true })) {
        const state = await this.context.storageState();
        fs.writeFileSync(sessionPath, JSON.stringify(state, null, 2));
        console.log("💾 Sesión guardada");
      }

      // Esperar a que la lista de chats cargue completamente
      console.log("⏳ Esperando que la lista de chats cargue...");
      await this.waitForChatList();

      // Buscar el grupo
      this.activeGroupId = await this.findGroupByNameWithRetry(this.config.groupName);
      if (this.activeGroupId) {
        console.log(`👥 Grupo encontrado: ${this.config.groupName}`);
        await this.startMessagePolling();
      } else {
        console.error(`❌ No se encontró el grupo '${this.config.groupName}'`);
        this.state.error = `No se encontró el grupo '${this.config.groupName}'`;
        this.notifyStateChange();
      }

    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      console.error("❌ Error al conectar WhatsApp:", error);

      this.state.isConnected = false;
      this.state.isConnecting = false;
      this.state.error = error;
      this.notifyStateChange();

      // Intentar reconectar
      if (this.reconnectAttempts < this.maxReconnectAttempts) {
        this.reconnectAttempts++;
        const delay = Math.pow(2, this.reconnectAttempts) * 1000;
        console.log(`🔄 Reintentando conexión (${this.reconnectAttempts}/${this.maxReconnectAttempts}) en ${delay}ms...`);
        setTimeout(() => {
          if (!this.isShuttingDown) {
            this.cleanup().then(() => this.connect());
          }
        }, delay);
      }
    }
  }

  /**
   * Maneja el QR code o el login automático
   */
  private async handleQROrLogin(): Promise<void> {
    const maxWaitTime = 120000; // 2 minutos
    const checkInterval = 500;
    const startTime = Date.now();

    while (Date.now() - startTime < maxWaitTime) {
      try {
        // Verificar si ya estamos conectados (el elemento main del chat está visible)
        const mainElement = this.page?.locator("main");
        const isMainVisible = await mainElement?.isVisible().catch(() => false);

        if (isMainVisible) {
          // Intentar obtener el usuario conectado
          const userProfile = await this.page?.locator('[data-testid="my-avatar"] img').getAttribute("src").catch(() => null);
          this.state.user = {
            id: userProfile || "unknown",
            name: "WhatsApp User",
          };
          console.log("✅ Sesión ya estaba conectada");
          return;
        }

        // Buscar QR code (canvas o img dentro del elemento de QR)
        const qrContainer = this.page?.locator('[data-testid="qrcode"] div canvas, canvas[aria-label*="Scan this QR code" i], canvas[title*="Scan this QR code" i]');

        const isQRVisible = await qrContainer?.isVisible().catch(() => false);

        if (isQRVisible) {
          console.log("📱 QR detectado, extrayendo código...");

          // Hacer screenshot del área del QR para capturar la imagen completa sin recortes
          try {
            const qrBoundingBox = await qrContainer?.boundingBox();
            if (qrBoundingBox && this.page) {
              // Ajustar el screenshot para capturar el área completa del QR
              const screenshotBuffer = await this.page.screenshot({
                clip: {
                  x: qrBoundingBox.x,
                  y: qrBoundingBox.y,
                  width: qrBoundingBox.width,
                  height: qrBoundingBox.height,
                },
              });

              // Convertir a base64 como data URL PNG
              const qrDataUrl = `data:image/png;base64,${screenshotBuffer.toString('base64')}`;

              console.log("📱 QR generado (escanea con tu teléfono)");
              // Enviar la data URL completa al dashboard
              this.state.qrCode = qrDataUrl;
              this.notifyQRCode(qrDataUrl);
              this.notifyStateChange();
              console.log("📱 Escanea el QR desde el dashboard web");
            }
          } catch (err) {
            console.error("⚠️ Error capturando QR:", err instanceof Error ? err.message : String(err));
            // Fallback: intentar capturar del canvas directamente
            const qrDataUrl = await qrContainer?.evaluate((el: HTMLCanvasElement) => {
              return el.toDataURL();
            }).catch(() => null);

            if (qrDataUrl) {
              console.log("📱 QR generado (método fallback)");
              this.state.qrCode = qrDataUrl;
              this.notifyQRCode(qrDataUrl);
              this.notifyStateChange();
            }
          }

          // Esperar conexión después de mostrar QR
          await this.waitForConnection();
          return;
        }

      } catch {
        // Continuar intentando
      }

      await new Promise(resolve => setTimeout(resolve, checkInterval));
    }

    throw new Error("Tiempo de espera agotado esperando QR o conexión");
  }

  /**
   * Espera a que se establezca la conexión después de escanear el QR
   */
  private async waitForConnection(): Promise<void> {
    const maxWaitTime = 120000; // 2 minutos
    const checkInterval = 500;
    const startTime = Date.now();

    console.log("⏳ Esperando conexión tras escanear QR...");

    while (Date.now() - startTime < maxWaitTime) {
      try {
        // Verificar si el QR ya no está visible (significa que se escaneó)
        const qrCanvas = this.page?.locator('[data-testid="qrcode"] div canvas, canvas[aria-label*="Scan this QR code" i], canvas[title*="Scan this QR code" i]');
        const isQRVisible = await qrCanvas?.isVisible().catch(() => true); // Por defecto true para no salir prematuramente

        // Verificar si el elemento principal de chat está visible
        const mainElement = this.page?.locator("main");
        const isMainVisible = await mainElement?.isVisible().catch(() => false);

        // Verificar si el avatar del usuario está presente
        const avatarElement = this.page?.locator('[data-testid="my-avatar"]');
        const isAvatarVisible = await avatarElement?.isVisible().catch(() => false);

        // Verificar si estamos en una URL de chat (ya no en la de QR)
        const currentUrl = this.page?.url() || "";
        const isChatUrl = currentUrl.includes("/chat") || currentUrl.includes("type=chat");

        console.log(`   Verificando: QR visible=${isQRVisible}, main visible=${isMainVisible}, avatar visible=${isAvatarVisible}, chat url=${isChatUrl}`);

        // Si el QR desapareció O el chat está visible, estamos conectados
        if (!isQRVisible || isMainVisible || isAvatarVisible || isChatUrl) {
          console.log("✅ Conexión detectada!");

          // Esperar un poco para que la interfaz cargue completamente
          await new Promise(resolve => setTimeout(resolve, 2000));

          const userProfile = await this.page?.locator('[data-testid="my-avatar"] img').getAttribute("src").catch(() => null);
          this.state.user = {
            id: userProfile || "connected",
            name: "WhatsApp User",
          };
          this.state.qrCode = null;
          this.notifyStateChange();
          this.notifyConnected();
          console.log("✅ Conexión exitosa tras escanear QR");
          return;
        }
      } catch (err) {
        console.log(`⚠️ Error verificando conexión: ${err instanceof Error ? err.message : String(err)}`);
      }

      await new Promise(resolve => setTimeout(resolve, checkInterval));
    }

    throw new Error("Tiempo de espera agotado esperando conexión tras escanear QR");
  }

  /**
   * Espera a que la lista de chats cargue completamente
   */
  private async waitForChatList(): Promise<void> {
    if (!this.page) {
      return;
    }

    const maxWaitTime = 30000; // 30 segundos
    const checkInterval = 500;
    const startTime = Date.now();

    while (Date.now() - startTime < maxWaitTime) {
      try {
        // Verificar si la lista de chats está visible con varios selectores
        const chatList = this.page.locator('[data-testid="chat-list"], [role="listbox"], div[data-testid="conversation-panel"]');
        const isChatListVisible = await chatList.isVisible().catch(() => false);

        // Verificar si hay al menos un chat item
        const chatItem = this.page.locator('[data-testid="chat-item"], [role="listitem"], div[data-testid="cell-frame-container"]');
        const chatCount = await chatItem.count();

        if (isChatListVisible || chatCount > 0) {
          console.log(`✅ Lista de chats cargada (${chatCount} chats)`);
          // Esperar un poco más para asegurar que todos los chats cargaron
          await this.page.waitForTimeout(1000);
          return;
        }
      } catch {
        // Continuar intentando
      }

      await new Promise(resolve => setTimeout(resolve, checkInterval));
    }

    console.log("⚠️ No se pudo cargar la lista de chats, pero continuando...");
  }

  /**
   * Busca un grupo por nombre
   */
  private async findGroupByName(name: string): Promise<string | null> {
    if (!this.page) {
      return null;
    }

    console.log(`🔍 Buscando grupo: "${name}"`);

    try {
      // Esperar a que la lista de chats cargue
      await this.page.waitForTimeout(2000);

      // Click en el buscador
      const searchInput = this.page.locator('[data-testid="chat-list-search"], [data-testid="left-hand-search"]');
      const searchInputField = this.page.locator('input[placeholder*="Search" i], [data-testid="chat-list-search"] input, input[type="text"]');

      console.log(`   Buscador visible: ${await searchInput.isVisible().catch(() => false)}`);

      // Intentar click en el buscador
      await searchInputField.click({ timeout: 5000 }).catch(async () => {
        // Si el click directo falla, intentar buscar por XPath
        if (this.page) {
          await this.page.click('//div[@data-testid="chat-list-search"]//input').catch(() => {});
        }
      });

      // Limpiar y escribir el nombre del grupo
      await searchInputField.fill("");
      await this.page.waitForTimeout(300);
      await searchInputField.type(name, { delay: 50 });

      console.log(`   Texto de búsqueda escrito: "${name}"`);

      // Esperar a que aparezcan resultados
      await this.page.waitForTimeout(2500);

      // Buscar el grupo en los resultados - intentar varios selectores
      const chatItems = this.page.locator('[data-testid="chat-item"], [role="listitem"][data-testid*="chat"], div[data-testid="cell-frame-container"]');
      const count = await chatItems.count();

      console.log(`   ${count} chat(s) encontrado(s)`);

      for (let i = 0; i < count; i++) {
        const item = chatItems.nth(i);

        // Intentar obtener el título del chat con varios selectores
        const title = await item.locator('[data-testid="chat-title"] span, [data-testid="chat-title"], span[dir="auto"]')
          .first()
          .textContent()
          .catch(() => "");

        const subtitle = await item.locator('[data-testid="chat-subtitle"] span, [data-testid="chat-subtitle"]')
          .textContent()
          .catch(() => "");

        const fullTitle = (title || "") + " " + (subtitle || "");
        const normalizedTitle = (title || "").trim().toLowerCase();
        const normalizedSearch = name.trim().toLowerCase();

        console.log(`   [${i + 1}] title="${title}" full="${fullTitle}"`);

        // Verificar si es el grupo buscado (exact match, substring, o contiene)
        if (title && (
          title === name ||
          title.includes(name) ||
          name.includes(title) ||
          normalizedTitle === normalizedSearch ||
          normalizedTitle.includes(normalizedSearch)
        )) {
          console.log(`   ✅ Grupo encontrado: "${title}"`);
          await item.click({ timeout: 5000 });
          await this.page.waitForTimeout(1500);

          // Extraer groupId de la URL
          const url = this.page.url();
          console.log(`   URL actual: ${url}`);
          const groupId = this.extractGroupIdFromUrl(url);
          console.log(`   GroupId extraído: ${groupId}`);
          return groupId;
        }
      }

      // Si no se encontró, listar todos los chats disponibles en la página para depuración
      console.log(`   ⚠️ Grupo "${name}" no encontrado. Listando chats disponibles...`);
      const allChats = this.page.locator('[data-testid="chat-title"]');
      const allCount = await allChats.count();
      console.log(`   Total de chats visibles: ${allCount}`);
      for (let i = 0; i < Math.min(allCount, 10); i++) {
        const chatTitle = await allChats.nth(i).textContent().catch(() => "");
        console.log(`   - "${chatTitle}"`);
      }

      // Limpiar búsqueda
      await searchInputField.fill("");
      await this.page.keyboard.press("Escape");
      await this.page.waitForTimeout(500);

      return null;
    } catch (err) {
      console.error(`⚠️ Error buscando grupo: ${err instanceof Error ? err.message : String(err)}`);
      console.error(`   Stack: ${err instanceof Error ? err.stack : 'N/A'}`);
      return null;
    }
  }

  /**
   * Busca un grupo por nombre con reintentos
   */
  private async findGroupByNameWithRetry(
    name: string,
    attempts = 10,
    delayMs = 1500
  ): Promise<string | null> {
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        const groupId = await this.findGroupByName(name);
        if (groupId) {
          return groupId;
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

  /**
   * Navega al grupo especificado
   */
  private async navigateToGroup(groupId: string): Promise<void> {
    if (!this.page) {
      return;
    }

    try {
      // Navegar directamente a la URL del grupo
      const chatJid = this.getChatJid(groupId);
      const url = `https://web.whatsapp.com/?tab=chat&jid=${encodeURIComponent(chatJid)}`;
      await this.page.goto(url, { waitUntil: "domcontentloaded" });
      await this.page.waitForTimeout(1000);
    } catch (err) {
      console.error(`⚠️ Error navegando al grupo: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * Inicia el polling de mensajes
   */
  private async startMessagePolling(): Promise<void> {
    if (!this.page || this.pollInterval) {
      return;
    }

    console.log("👂 Escuchando mensajes...");

    this.pollInterval = setInterval(async () => {
      try {
        await this.pollMessages();
      } catch (err) {
        console.error(`⚠️ Error en polling de mensajes: ${err instanceof Error ? err.message : String(err)}`);
      }
    }, 2000);

    // Verificar conexión periodicamente
    this.checkQRInterval = setInterval(async () => {
      try {
        const mainElement = this.page?.locator("main");
        const isMainVisible = await mainElement?.isVisible().catch(() => false);

        if (!isMainVisible && this.state.isConnected) {
          console.log("⚠️ Desconexión detectada");
          this.state.isConnected = false;
          this.notifyDisconnected();
          this.notifyStateChange();

          if (!this.isShuttingDown && this.reconnectAttempts < this.maxReconnectAttempts) {
            this.reconnectAttempts++;
            console.log(`🔄 Reintentando conexión (${this.reconnectAttempts}/${this.maxReconnectAttempts})...`);
            this.cleanup().then(() => this.connect());
          }
        }
      } catch {
        // ignore
      }
    }, 10000);
  }

  /**
   * Hace polling de nuevos mensajes
   */
  private async pollMessages(): Promise<void> {
    if (!this.page || !this.messageHandler || !this.activeGroupId) {
      return;
    }

    try {
      // Asegurarnos de que estamos en el chat del grupo
      const currentUrl = this.page.url();
      const currentGroupId = this.extractGroupIdFromUrl(currentUrl);

      if (!currentGroupId || currentGroupId !== this.activeGroupId) {
        await this.navigateToGroup(this.activeGroupId);
        await this.page.waitForTimeout(500);
        return;
      }

      // Obtener todos los contenedores de mensajes
      const messageContainers = this.page.locator('[data-testid="msg-container"]');
      const count = await messageContainers.count();

      // Si no hay nuevos mensajes, salir
      if (count <= this.lastProcessedMessageCount) {
        return;
      }

      // Procesar mensajes nuevos (del último al primero para mantener orden cronológico)
      for (let i = this.lastProcessedMessageCount; i < count; i++) {
        try {
          await this.processMessage(messageContainers.nth(i));
        } catch (err) {
          console.error(`⚠️ Error procesando mensaje ${i}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      this.lastProcessedMessageCount = count;
    } catch (err) {
      // Silencioso, errores comunes al hacer polling
    }
  }

  /**
   * Procesa un mensaje individual
   */
  private async processMessage(messageContainer: Locator): Promise<void> {
    try {
      // Extraer ID del mensaje
      const dataId = await messageContainer.getAttribute("data-id");
      if (!dataId || this.seenMessageIds.has(dataId)) {
        return;
      }

      // Verificar si es mensaje saliente (nuestro)
      const isOutgoing = await messageContainer.getAttribute("data-is-outgoing");
      if (isOutgoing === "true") {
        this.seenMessageIds.add(dataId);
        return;
      }

      this.seenMessageIds.add(dataId);

      // Extraer contenido del mensaje
      const textElement = messageContainer.locator('[data-testid="msg-text"] span, [data-testid="conversation-panel-msg"] span');
      const content = await textElement.allTextContents().then(texts => texts.join("\n")).catch(() => "");

      // Verificar si es multimedia
      const hasImage = await messageContainer.locator('[data-testid="msg-img"]').count() > 0;
      const hasVideo = await messageContainer.locator('[data-testid="msg-video"]').count() > 0;
      const hasMedia = hasImage || hasVideo;
      const mediaType = hasImage ? "image" : hasVideo ? "video" : null;

      // Extraer información del remitente
      const senderElement = messageContainer.locator('[data-testid="msg-author"], [data-testid="chat-title"] span');
      let senderLabel = await senderElement.textContent().catch(() => "Desconocido");

      // Si el remitente es el grupo, obtener el nombre del mensaje
      if (!senderLabel || senderLabel.trim() === "") {
        senderLabel = await messageContainer.locator('[data-testid="chat-title"]').textContent().catch(() => "Desconocido");
      }

      senderLabel = senderLabel?.trim() || "Desconocido";

      // Intentar extraer el ID/número del remitente del atributo data-pre-plain-text
      const plainText = await messageContainer.getAttribute("data-pre-plain-text").catch(() => "");
      let senderNumber: string | null = null;
      let senderId: string | null = null;

      // Extraer número del texto plano (formato: [number, date] text)
      const phoneMatch = plainText?.match(/\[?\+?(\d{10,15})\]?/);
      if (phoneMatch) {
        senderNumber = phoneMatch[1];
      }

      // Extraer ID del atributo data-from-me o data-sender
      senderId = await messageContainer.getAttribute("data-sender").catch(() => null);

      // Fallback: usar senderLabel si es un número
      if (!senderNumber && /^\d{10,15}$/.test(senderLabel)) {
        senderNumber = senderLabel;
      }

      const timestamp = new Date();

      console.log(`📨 [MENSAJE] from="${senderLabel}" number="${senderNumber}" id="${senderId}" text="${content.substring(0, 50)}..."`);

      const incoming: IncomingMessage = {
        body: content || (hasMedia ? `[media:${mediaType}]` : ""),
        timestamp,
        senderLabel,
        senderId,
        senderNumber,
        chatId: this.activeGroupId!,
        hasMedia,
        mediaType,
        getMedia: async () => {
          // Implementación futura para descargar media
          return null;
        },
        reply: async (text: string) => {
          await this.sendMessage(this.activeGroupId!, text);
        },
        react: async (emoji: string) => {
          await this.reactToMessage(dataId, emoji);
        },
        sendPoll: async (title: string, options: string[], allowMultiple = false) => {
          return await this.sendPollToGroup(this.activeGroupId!, title, options, allowMultiple);
        },
      };

      // Llamar al handler de mensajes
      if (this.messageHandler) {
        try {
          await this.messageHandler(incoming);
        } catch (err) {
          console.error(`❌ Error en handler de mensaje: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    } catch (err) {
      console.error(`⚠️ Error procesando mensaje: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * Envía un mensaje de texto
   */
  async sendMessage(groupId: string, text: string): Promise<void> {
    if (!this.page) {
      throw new Error("Page no disponible");
    }

    try {
      console.log(`📤 Enviando mensaje a ${groupId}: "${text.substring(0, 50)}..."`);

      // Asegurarnos de estar en el chat correcto
      const currentUrl = this.page.url();
      const currentGroupId = this.extractGroupIdFromUrl(currentUrl);

      if (currentGroupId !== groupId) {
        await this.navigateToGroup(groupId);
        await this.page.waitForTimeout(500);
      }

      // Encontrar el input de mensaje
      const messageInput = this.page.locator('[data-testid="conversation-panel-body"] [contenteditable="true"][data-text="Message"]');

      // Click en el input
      await messageInput.click({ timeout: 5000 });

      // Limpiar y escribir el mensaje
      await messageInput.fill("");
      await this.page.keyboard.type(text);

      // Presionar Enter para enviar
      await this.page.keyboard.press("Enter");

      // Esperar que el mensaje se envíe
      await this.page.waitForTimeout(500);

      console.log(`✅ Mensaje enviado`);
    } catch (err) {
      console.error(`❌ Error enviando mensaje: ${err instanceof Error ? err.message : String(err)}`);
      throw err;
    }
  }

  /**
   * Reacciona a un mensaje con un emoji
   */
  private async reactToMessage(messageId: string, emoji: string): Promise<void> {
    if (!this.page) {
      return;
    }

    try {
      // Encontrar el mensaje por su ID
      const message = this.page.locator(`[data-id="${messageId}"]`);

      // Click derecho en el mensaje
      await message.click({ button: "right" });

      // Esperar que aparezca el menú contextual
      await this.page.waitForTimeout(200);

      // Buscar la opción de emoji
      const emojiButton = this.page.locator('[title="Emoji"], [data-testid="emoji-icon"]').first();
      if (await emojiButton.isVisible().catch(() => false)) {
        await emojiButton.click();
        await this.page.waitForTimeout(200);

        // Seleccionar el emoji (implementación básica)
        // En una implementación completa, buscaría el emoji específico en la lista
      }

      // Cerrar el menú si no se encontró
      await this.page.keyboard.press("Escape");
    } catch (err) {
      console.error(`⚠️ Error reaccionando al mensaje: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * Envía una encuesta al grupo
   */
  private async sendPollToGroup(
    groupId: string,
    title: string,
    options: string[],
    allowMultiple = false
  ): Promise<string | null> {
    if (!this.page) {
      return null;
    }

    try {
      // Asegurarnos de estar en el chat correcto
      const currentUrl = this.page.url();
      const currentGroupId = this.extractGroupIdFromUrl(currentUrl);

      if (currentGroupId !== groupId) {
        await this.navigateToGroup(groupId);
        await this.page.waitForTimeout(500);
      }

      // Click en el botón de adjuntar (clip)
      const attachButton = this.page.locator('[data-testid="attach-menu"]');
      await attachButton.click();
      await this.page.waitForTimeout(200);

      // Seleccionar la opción de encuesta (Poll)
      // Nota: La ubicación exacta puede variar según la versión de WhatsApp Web
      const pollButton = this.page.locator('[title="Poll"], [data-testid="poll"]').first();
      if (await pollButton.isVisible().catch(() => false)) {
        await pollButton.click();
        await this.page.waitForTimeout(300);

        // Escribir el título
        const titleInput = this.page.locator('[data-testid="poll-create-dialog-title"] input');
        await titleInput.fill(title);

        // Agregar opciones
        for (let i = 0; i < options.length; i++) {
          const optionInput = this.page.locator('[data-testid="poll-create-dialog-options"] input').nth(i);
          if (optionInput) {
            await optionInput.fill(options[i]);
            if (i < options.length - 1) {
              const addButton = this.page.locator('[data-testid="poll-create-dialog-add-option"]');
              await addButton.click();
            }
          }
        }

        // Enviar la encuesta
        const sendButton = this.page.locator('[data-testid="poll-create-dialog-send"]');
        await sendButton.click();

        await this.page.waitForTimeout(500);

        // Generar un ID ficticio para la encuesta
        const pollId = `poll_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        return pollId;
      } else {
        console.log("⚠️ No se encontró el botón de encuesta");
        return null;
      }
    } catch (err) {
      console.error(`⚠️ Error enviando encuesta: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  }

  async logout(): Promise<void> {
    await this.cleanup();
    this.state.isConnected = false;
    this.state.isConnecting = false;
    this.state.qrCode = null;
    this.state.user = null;
    this.state.error = null;
    this.reconnectAttempts = 0;
    this.notifyStateChange();
    console.log("🚪 WhatsApp logout completado");
  }

  /**
   * Limpia recursos (browser, context, page)
   */
  private async cleanup(): Promise<void> {
    this.isShuttingDown = true;

    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }

    if (this.checkQRInterval) {
      clearInterval(this.checkQRInterval);
      this.checkQRInterval = null;
    }

    if (this.page) {
      await this.page.close().catch(() => {});
      this.page = null;
    }

    if (this.context) {
      await this.context.close().catch(() => {});
      this.context = null;
    }

    if (this.browser) {
      await this.browser.close().catch(() => {});
      this.browser = null;
    }

    this.isShuttingDown = false;
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

  /**
   * Imprime el QR en la terminal desde base64
   */
  private printQRFromBase64(base64: string): void {
    try {
      console.log("📱 Escanea este QR con WhatsApp:");
      // qrcode-terminal no soporta base64 directamente, pero podemos intentar
      // Primero decodificar y luego generar
      const buffer = Buffer.from(base64, "base64");
      const qrCode = buffer.toString("utf-8").trim();
      qrcode.generate(qrCode, { small: true });
    } catch {
      console.log("📱 QR disponible en el dashboard web");
    }
  }

  /**
   * Devuelve el ID del grupo activo
   */
  getActiveGroupId(): string | null {
    return this.activeGroupId;
  }
}
