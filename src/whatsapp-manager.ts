import makeWASocket, {
  DisconnectReason,
  fetchLatestBaileysVersion,
  useMultiFileAuthState,
  type WASocket,
  type WAConnectionState,
  type WAMessage,
  type Contact,
  jidNormalizedUser,
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
  private contactsStore = new Map<string, Contact>();

  constructor(config: WhatsappConfig) {
    this.config = config;
  }

  /**
   * Extrae el número de teléfono de un JID de WhatsApp
   * Ej: "51997314528@s.whatsapp.net" -> "51997314528"
   */
  private extractNumberFromJid(jid: string): string | null {
    try {
      const normalized = jidNormalizedUser(jid);
      const atIndex = normalized.indexOf("@");
      const userPart = atIndex > 0 ? normalized.slice(0, atIndex) : normalized;
      const digits = userPart.replace(/\D+/g, "");
      return digits.length >= 10 ? digits : null;
    } catch {
      return null;
    }
  }

  /**
   * Lista todos los participantes del grupo con su información
   */
  private async listGroupParticipants(groupId: string): Promise<void> {
    try {
      // Esperar 5 segundos para dar tiempo a que lleguen los contacts.upsert
      console.log('⏳ Esperando 5 segundos para cargar contactos...');
      await new Promise(resolve => setTimeout(resolve, 5000));
      
      const groupMetadata = await this.socket?.groupMetadata(groupId);
      if (!groupMetadata) {
        console.log('⚠️ No se pudo obtener la metadata del grupo');
        return;
      }

      const participants = groupMetadata.participants || [];
      
      // Obtener todos los contactos del store interno de Baileys
      const baileysContacts = (this.socket as any)?.contactStore?.contacts || {};
      
      console.log('');
      console.log('═'.repeat(150));
      console.log(`👥 PARTICIPANTES DEL GRUPO "${groupMetadata.subject}"`);
      console.log(`   Total: ${participants.length} participante(s)`);
      console.log('═'.repeat(150));
      console.log('PARTICIPANT.ID'.padEnd(30) + ' | ' + 'CONTACT STORE'.padEnd(10) + ' | ' + 'CONTACT.ID'.padEnd(30) + ' | ' + 'CONTACT.NOTIFY'.padEnd(20) + ' | ' + 'CONTACT.NAME'.padEnd(20) + ' | ' + 'PHONE EXTRACTED');
      console.log('─'.repeat(150));

      for (const participant of participants) {
        const pId = participant.id;
        
        // Buscar en el contactStore de Baileys (probar con ambos formatos)
        const baileysContact = baileysContacts[pId] || 
                               baileysContacts[pId.replace('@lid', '@s.whatsapp.net')] || 
                               baileysContacts[pId.replace('@lid', '@c.us')] ||
                               null;
        
        // También buscar en nuestro contactsStore
        const ourContact = this.contactsStore.get(pId);
        
        // Usar el contacto que tenga más información
        const contact = baileysContact || ourContact;
        
        const inStore = contact ? '✅ SI' : '❌ NO';
        const contactId = contact?.id || 'N/A';
        const contactNotify = contact?.notify || 'N/A';
        const contactName = contact?.name || 'N/A';
        
        // Extraer teléfono del ID
        const phoneExtracted = pId.replace(/\D/g, '');
        
        console.log(
          pId.padEnd(30) + ' | ' +
          inStore.padEnd(10) + ' | ' +
          contactId.padEnd(30) + ' | ' +
          String(contactNotify).padEnd(20) + ' | ' +
          String(contactName).padEnd(20) + ' | ' +
          phoneExtracted
        );
      }

      console.log('═'.repeat(150));
      
      // Mostrar resumen del contactStore
      console.log('');
      console.log('📊 RESUMEN DEL CONTACT STORE DE BAILEYS:');
      console.log(`   Total contactos en store: ${Object.keys(baileysContacts).length}`);
      console.log('');
      
      // Mostrar instrucciones
      console.log('💡 INSTRUCCIONES:');
      console.log('   Los LIDs son IDs temporales de WhatsApp por privacidad.');
      console.log('   Para obtener los números reales (+51...):');
      console.log('');
      console.log('   OPCIÓN 1 - Que envíen mensajes:');
      console.log('   1. Pide a cada técnico que envíe un mensaje al grupo');
      console.log('   2. Revisa los logs del mensaje para ver el LID');
      console.log('   3. Agrega el LID al numbers-map.json:');
      console.log('      "NOMBRE": ["51997314528", "GLPI_ID", "LID_AQUI"]');
      console.log('');
      console.log('   OPCIÓN 2 - Forzar sincronización (puede fallar):');
      console.log('   El bot intentará obtener los números automáticamente...');
      console.log('');
      
      // Intentar sincronización USync
      console.log('🔄 Intentando sincronización USync para obtener números...');
      await this.syncParticipantsNumbers(participants);
      
      console.log('═'.repeat(150));
      
    } catch (err) {
      console.log(`⚠️ Error al listar participantes: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * Intenta obtener los números reales de los participantes usando USync
   */
  private async syncParticipantsNumbers(participants: Array<{ id: string }>): Promise<void> {
    if (!this.socket) {
      console.log('   ❌ Socket no disponible');
      return;
    }

    try {
      // Extraer todos los LIDs
      const lids = participants.map(p => p.id);
      console.log(`   📋 Sincronizando ${lids.length} participantes...`);
      
      // Intentar USync
      const result = await (this.socket as any).onUSync({
        tag: 'usync',
        attrs: {
          sid: '0',
          mode: 'query',
          last: 'true',
          index: '0',
        },
        content: [{
          tag: 'query',
          attrs: {},
          content: [{
            tag: 'contact',
            attrs: {},
            content: undefined,
          }],
        }, {
          tag: 'list',
          attrs: {},
          content: lids.map(lid => ({
            tag: 'user',
            attrs: {
              jid: lid,
            },
          })),
        }],
      });
      
      console.log('   📊 Resultado USync:', JSON.stringify(result, null, 2));
    } catch (err) {
      console.log(`   ⚠️ USync no disponible o falló: ${err instanceof Error ? err.message : String(err)}`);
      console.log('   💡 Usa la OPCIÓN 1 (que envíen mensajes)');
    }
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

          // Los contactos se cargarán automáticamente vía contacts.upsert

          // Encontrar el grupo y configurar listener de mensajes
          this.activeGroupId = await this.findGroupByNameWithRetry(this.config.groupName);
          if (this.activeGroupId) {
            console.log(`👥 Grupo encontrado: ${this.config.groupName} (${this.activeGroupId})`);
            
            // Listar participantes del grupo
            await this.listGroupParticipants(this.activeGroupId);
            
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


      this.socket.ev.on("contacts.update", (contacts: Partial<Contact>[]) => {
        console.log(`📇 [CONTACTS.UPDATE] ${contacts.length} contacto(s)`);
        for (const contact of contacts) {
          if (contact.id) {
            const existing = this.contactsStore.get(contact.id);
            if (existing) {
              this.contactsStore.set(contact.id, { ...existing, ...contact });
              console.log(`   └─ Actualizado: id="${contact.id}"`);
            } else {
              this.contactsStore.set(contact.id, contact as Contact);
              console.log(`   └─ Nuevo (update): id="${contact.id}"`);
            }
          }
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

        // ========== EXTRACCIÓN DE NÚMERO DEL REMITENTE ==========
        console.log(`📨 [MENSAJE] senderId="${senderId}", pushName="${msg.pushName}"`);
        
        let senderNumber: string | null = null;
        const pushName = msg.pushName;

        // PASO 1: Intentar con pushName
        if (pushName) {
          const normalizedPush = pushName.replace(/\D/g, "");
          console.log(`   🔍 PASO 1 [pushName]: "${pushName}" -> "${normalizedPush}" (len=${normalizedPush.length})`);
          if (normalizedPush.length >= 10 && normalizedPush.length <= 15) {
            senderNumber = normalizedPush;
            console.log(`   ✅ pushName VÁLIDO: ${senderNumber}`);
          } else {
            console.log(`   ❌ pushName INVÁLIDO (fuera de rango 10-15)`);
          }
        }

        // PASO 2: Intentar con contactsStore
        if (!senderNumber) {
          console.log(`   🔍 PASO 2 [contactsStore]...`);
          const contact = this.contactsStore.get(senderId);
          if (contact) {
            console.log(`   📇 Contacto ENCONTRADO: id="${contact.id}", notify="${contact.notify}"`);

            if (!senderNumber && contact?.id) {
              const idNumber = this.extractNumberFromJid(contact.id);
              console.log(`      └─ id="${contact.id}" -> "${idNumber}"`);
              if (idNumber && idNumber.length >= 10 && idNumber.length <= 15) {
                senderNumber = idNumber;
                console.log(`      ✅ USANDO id: ${senderNumber}`);
              }
            }

            if (!senderNumber && contact?.notify) {
              const normalizedNotify = contact.notify.replace(/\D/g, "");
              console.log(`      └─ notify="${contact.notify}" -> "${normalizedNotify}"`);
              if (normalizedNotify.length >= 10 && normalizedNotify.length <= 15) {
                senderNumber = normalizedNotify;
                console.log(`      ✅ USANDO notify: ${senderNumber}`);
              }
            }
          } else {
            console.log(`   ❌ Contacto NO encontrado en store`);
          }
        }

        // PASO 3: Fallback - extraer del senderId original
        if (!senderNumber) {
          console.log(`   🔍 PASO 3 [fallback senderId]...`);
          senderNumber = this.extractNumberFromJid(senderId);
          console.log(`      └─ senderId="${senderId}" -> "${senderNumber}"`);
        }

        const senderLabel = msg.pushName || senderNumber || "Desconocido";
        console.log(`   📋 RESULTADO: senderNumber="${senderNumber}", senderLabel="${senderLabel}"`);
        console.log(`   ${'='.repeat(50)}`);
        
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
          getMedia: async () => {
            console.log(`   📥 [getMedia] llamado`);
            return null;
          },
          reply: async (text: string) => {
            console.log(`   📤 [reply] INICIO - text="${text.substring(0, 50)}..."`);
            console.log(`   📤 [reply] this.socket=${this.socket ? '✅ disponible' : '❌ null'}`);
            console.log(`   📤 [reply] chatId="${chatId}"`);
            console.log(`   📤 [reply] id="${id}"`);
            
            if (!this.socket) {
              console.log(`   ❌ [reply] Socket es null, retornando`);
              return;
            }
            
            console.log(`   📤 [reply] Agregando a ignoredMessageIds`);
            ignoredMessageIds.add(id);
            
            try {
              console.log(`   📤 [reply] Llamando a sendMessage...`);
              const sent = await this.socket.sendMessage(chatId, { text });
              console.log(`   📤 [reply] sendMessage retornó:`, JSON.stringify(sent?.key || null));
              
              const sentId = sent?.key?.id;
              console.log(`   📤 [reply] sentId="${sentId}"`);
              
              if (sentId) {
                console.log(`   📤 [reply] Agregando sentId a ignoredMessageIds`);
                ignoredMessageIds.add(sentId);
                console.log(`   ✅ [reply] COMPLETADO EXITOSAMENTE`);
              } else {
                console.log(`   ⚠️ [reply] sentId es null/undefined`);
              }
            } catch (err) {
              console.error(`   ❌ [reply] ERROR en sendMessage: ${err instanceof Error ? err.message : String(err)}`);
              if (err instanceof Error && err.stack) {
                console.error(`   ❌ [reply] Stack: ${err.stack}`);
              }
              throw err; // Re-lanzar para que handleRegister lo capture
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
