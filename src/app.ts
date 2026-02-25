import { loadConfig } from "./config";
import { GlpiClient } from "./glpi";
import { GlpiWebClient } from "./glpi-web";
import { WhatsAppManager } from "./whatsapp-manager";
import { WebServer } from "./web-server";
import { TicketFlow } from "./ticket-flow";
import { loadCategories } from "./categories";
import { startWhatsAppListener } from "./whatsapp";

export async function run(): Promise<void> {
  const config = loadConfig();
  
  console.log('🚀 Iniciando GLPI WhatsApp Bot...');
  console.log('   - Web Server:', config.webServer.enabled ? `Puerto ${config.webServer.port}` : 'Deshabilitado');
  console.log('   - GLPI Web API:', config.glpiWeb.useWebApi ? 'Habilitado (cookies)' : 'Deshabilitado (API REST)');
  
  // Inicializar clientes GLPI
  let glpiRest: GlpiClient | null = null;
  let glpiWeb: GlpiWebClient | null = null;
  
  if (!config.glpiWeb.useWebApi) {
    glpiRest = new GlpiClient(config.glpi);
    console.log('✅ GLPI REST API inicializado');
  } else {
    glpiWeb = new GlpiWebClient(
      config.glpi.baseUrl || '',
      config.glpiWeb.loginUrl,
      config.glpiWeb.cookieFile,
      config.glpi.user,
      config.glpi.password
    );
    
    // Cargar cookies existentes
    const hasCookies = await glpiWeb.loadCookies();
    if (hasCookies) {
      const isValid = await glpiWeb.isSessionValid();
      console.log(`✅ GLPI Web API inicializado - Sesión ${isValid ? 'válida' : 'expirada'}`);
    } else {
      console.log('⚠️ GLPI Web API: Sin sesión. Usa el dashboard para iniciar sesión.');
    }
  }
  
  // Cargar categorías
  const categories = loadCategories(config.categoriesPath);
  const defaultCategoryName =
    categories.find(
      (entry) => entry.glpiCategoryId === config.defaultCategoryId
    )?.category ?? undefined;
  
  // Inicializar WhatsApp Manager
  const whatsappManager = new WhatsAppManager(config.whatsapp);

  // Configurar handler para actualizaciones de estado
  const webServer = config.webServer.enabled
    ? new WebServer(config, glpiWeb!, whatsappManager)
    : null;

  whatsappManager.setHandler({
    onStateChange: (state) => {
      console.log(`📱 WhatsApp: ${state.isConnected ? 'Conectado' : state.qrCode ? 'Esperando QR' : 'Desconectado'}`);
      webServer?.onWhatsAppStateChange();
    },
    onQRCode: (qr) => {
      console.log('📱 Escanea el QR en el dashboard');
      // Notificar inmediatamente a los clientes WebSocket
      webServer?.broadcast({ type: 'whatsapp-qr', qrCode: qr });
    },
    onConnected: () => {
      console.log('✅ WhatsApp conectado exitosamente');
    },
    onDisconnected: () => {
      console.log('🔌 WhatsApp desconectado');
    },
  });

  // Iniciar web server primero para que esté listo cuando llegue el QR
  if (webServer) {
    webServer.start();
    // Pequeña pausa para que el servidor esté listo
    await new Promise(resolve => setTimeout(resolve, 500));
  }

  // Inicializar WhatsApp (esto disparará el QR)
  await whatsappManager.initialize();

  // Crear TicketFlow con el cliente GLPI apropiado
  const ticketFlow = new TicketFlow(
    glpiRest!,
    {
      defaultCategoryId: config.defaultCategoryId,
      defaultCategoryName,
      techniciansByPhone: config.techniciansByPhone,
    }
  );

  // Iniciar listener de WhatsApp
  startWhatsAppListener(
    config.whatsapp,
    async (message) => {
      const mediaTag =
        message.hasMedia && !message.body.startsWith("[media:")
          ? ` [media:${message.mediaType || "desconocido"}]`
          : "";
      console.log(
        `[${message.timestamp.toISOString()}] ${message.senderLabel}: ${message.body}${mediaTag}`
      );
      try {
        await ticketFlow.handleMessage(message);
      } catch (err) {
        const messageText = err instanceof Error ? err.message : String(err);
        console.error(`❌ Error al procesar mensaje: ${messageText}`);
        if (err instanceof Error && err.stack) {
          console.error(`Stack trace: ${err.stack}`);
        }
        try {
          await message.reply(
            `Error en GLPI: ${messageText}. Intenta nuevamente o contacta al administrador.`
          );
        } catch {
          // ignore reply failures
        }
      }
    },
    async (vote) => {
      const selected = vote.selectedOptionNames.length > 0
        ? vote.selectedOptionNames.join(", ")
        : vote.selectedOptionIds.join(", ");
      console.log(
        `[${vote.timestamp.toISOString()}] ${vote.senderLabel}: [encuesta] ${selected}`
      );
      try {
        await ticketFlow.handlePollVote(vote);
      } catch (err) {
        const messageText = err instanceof Error ? err.message : String(err);
        console.error(`Error al procesar encuesta: ${messageText}`);
        try {
          await vote.reply(
            "Ocurrio un error al procesar la encuesta. Intenta nuevamente."
          );
        } catch {
          // ignore reply failures
        }
      }
    }
  );
  
  console.log('🎉 Bot iniciado exitosamente');
  if (config.webServer.enabled) {
    console.log(`🌐 Dashboard: http://localhost:${config.webServer.port}`);
  }
}
