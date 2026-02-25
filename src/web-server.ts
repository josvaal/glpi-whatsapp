import express, { Request, Response } from "express";
import path from "path";
import fs from "fs";
import { WebSocketServer, WebSocket } from "ws";
import http from "http";

import type { AppConfig } from "./config";
import { GlpiWebClient } from "./glpi-web";
import { WhatsAppManager } from "./whatsapp-manager";

export class WebServer {
  private app: express.Application;
  private server: http.Server;
  private wss: WebSocketServer;
  private port: number;
  private glpiClient: GlpiWebClient | null;
  private whatsappManager: WhatsAppManager;
  private clients: Set<WebSocket> = new Set();
  private logs: string[] = [];

  constructor(
    config: AppConfig,
    glpiClient: GlpiWebClient | null,
    whatsappManager: WhatsAppManager
  ) {
    this.port = config.webServer.port;
    this.glpiClient = glpiClient;
    this.whatsappManager = whatsappManager;

    this.app = express();
    this.server = http.createServer(this.app);
    this.wss = new WebSocketServer({ server: this.server, path: "/ws" });

    this.setupMiddleware();
    this.setupRoutes();
    this.setupWebSocket();
  }

  private setupMiddleware(): void {
    this.app.use(express.json());
    this.app.use(express.urlencoded({ extended: true }));
  }

  private setupRoutes(): void {
    // Servir dashboard HTML
    this.app.get("/", (req: Request, res: Response) => {
      const htmlPath = path.join(__dirname, "web-server", "index.html");
      if (fs.existsSync(htmlPath)) {
        res.sendFile(htmlPath);
      } else {
        res.status(404).send("Dashboard not found");
      }
    });

    // API: Estado general
    this.app.get("/api/status", (req: Request, res: Response) => {
      const whatsappState = this.whatsappManager.getState();
      const glpiStatus = this.glpiClient ? this.glpiClient.getSessionStatus() : { isValid: false };

      res.json({
        whatsapp: whatsappState,
        glpi: glpiStatus,
        logs: this.logs.slice(-50),
      });
    });

    // API: WhatsApp QR
    this.app.get("/api/whatsapp/qr", (req: Request, res: Response) => {
      const state = this.whatsappManager.getState();
      res.json({
        qrCode: state.qrCode,
        isConnected: state.isConnected,
      });
    });

    // API: WhatsApp logout
    this.app.post("/api/whatsapp/logout", async (req: Request, res: Response) => {
      try {
        await this.whatsappManager.logout();
        this.broadcast({ type: "whatsapp-logout", state: this.whatsappManager.getState() });
        res.json({ success: true });
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        res.status(500).json({ success: false, error });
      }
    });

    // API: GLPI estado
    this.app.get("/api/glpi/status", async (req: Request, res: Response) => {
      if (!this.glpiClient) {
        res.json({ isValid: false, error: "GLPI Web API no está habilitado" });
        return;
      }
      try {
        const isValid = await this.glpiClient.isSessionValid();
        const status = this.glpiClient.getSessionStatus();
        res.json({
          isValid,
          expiresAt: status.expiresAt,
          userId: status.userId,
        });
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        res.status(500).json({ success: false, error });
      }
    });

    // API: GLPI iniciar login MFA (flujo automatico con HTTP)
    this.app.post("/api/glpi/login-start", async (req: Request, res: Response) => {
      if (!this.glpiClient) {
        res.status(400).json({ success: false, error: "GLPI Web API no está habilitado. Configura GLPI_USE_WEB_API=true" });
        return;
      }
      try {
        this.log("🔐 Iniciando login de GLPI con credenciales...");
        const state = await this.glpiClient.startLoginWithMfa();
        
        if (state.step === 'awaiting-mfa') {
          this.log("✅ Login inicial exitoso, esperando código MFA");
          res.json({ success: true, step: 'awaiting-mfa' });
        } else if (state.step === 'error') {
          this.log(`❌ Error en login GLPI: ${state.error}`);
          res.status(400).json({ success: false, error: state.error });
        } else {
          res.json({ success: true, step: state.step });
        }
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        this.log(`❌ Error en login GLPI: ${error}`);
        res.status(500).json({ success: false, error });
      }
    });

    // API: GLPI submit MFA code (flujo automatico con HTTP)
    this.app.post("/api/glpi/mfa-submit", async (req: Request, res: Response) => {
      if (!this.glpiClient) {
        res.status(400).json({ success: false, error: "GLPI Web API no está habilitado" });
        return;
      }
      const { code } = req.body;

      if (!code || typeof code !== "string") {
        res.status(400).json({ success: false, error: "Código MFA requerido" });
        return;
      }

      try {
        this.log(`🔢 Enviando código MFA: ${code.slice(0, 2)}**`);
        const result = await this.glpiClient.submitMfaCodeHttp(code);

        if (result.success) {
          this.log("✅ Código MFA aceptado, sesión guardada");
          this.broadcast({ type: "glpi-login-success", status: this.glpiClient.getSessionStatus() });
        } else {
          this.log(`❌ Error con código MFA: ${result.error}`);
        }

        res.json(result);
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        this.log(`❌ Error con MFA: ${error}`);
        res.status(500).json({ success: false, error });
      }
    });

    // API: GLPI iniciar login MFA (flujo antiguo con navegador - mantener por compatibilidad)
    this.app.post("/api/glpi/login", async (req: Request, res: Response) => {
      if (!this.glpiClient) {
        res.status(400).json({ success: false, error: "GLPI Web API no está habilitado. Configura GLPI_USE_WEB_API=true" });
        return;
      }
      try {
        this.log("🔐 Iniciando login de GLPI con navegador...");
        const result = await this.glpiClient.startMfaLogin();

        if (result.success) {
          this.log("✅ Login de GLPI completado");
          this.broadcast({ type: "glpi-login-success", status: this.glpiClient.getSessionStatus() });
        } else {
          this.log(`❌ Error en login GLPI: ${result.error}`);
        }

        res.json(result);
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        this.log(`❌ Error en login GLPI: ${error}`);
        res.status(500).json({ success: false, error });
      }
    });

    // API: GLPI submit MFA code
    this.app.post("/api/glpi/mfa", async (req: Request, res: Response) => {
      if (!this.glpiClient) {
        res.status(400).json({ success: false, error: "GLPI Web API no está habilitado" });
        return;
      }
      const { code } = req.body;

      if (!code || typeof code !== "string") {
        res.status(400).json({ success: false, error: "Código MFA requerido" });
        return;
      }

      try {
        this.log(`🔢 Enviando código MFA: ${code.slice(0, 2)}**`);
        const result = await this.glpiClient.submitMfaCode(code);

        if (result.success) {
          this.log("✅ Código MFA aceptado");
          this.broadcast({ type: "glpi-mfa-success", status: this.glpiClient.getSessionStatus() });
        } else {
          this.log(`❌ Error con código MFA: ${result.error}`);
        }

        res.json(result);
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        this.log(`❌ Error con MFA: ${error}`);
        res.status(500).json({ success: false, error });
      }
    });

    // API: GLPI logout
    this.app.post("/api/glpi/logout", async (req: Request, res: Response) => {
      if (!this.glpiClient) {
        res.status(400).json({ success: false, error: "GLPI Web API no está habilitado" });
        return;
      }
      try {
        await this.glpiClient.logout();
        this.log("🚪 Sesión de GLPI cerrada");
        this.broadcast({ type: "glpi-logout", status: { isValid: false } });
        res.json({ success: true });
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        res.status(500).json({ success: false, error });
      }
    });

    // API: GLPI verificar sesión
    this.app.post("/api/glpi/verify", async (req: Request, res: Response) => {
      if (!this.glpiClient) {
        res.json({ isValid: false, error: "GLPI Web API no está habilitado" });
        return;
      }
      try {
        const isValid = await this.glpiClient.isSessionValid();
        const status = this.glpiClient.getSessionStatus();
        res.json({
          isValid,
          expiresAt: status.expiresAt,
          userId: status.userId,
        });
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        res.status(500).json({ success: false, error });
      }
    });

    // API: Logs
    this.app.get("/api/logs", (req: Request, res: Response) => {
      res.json({ logs: this.logs.slice(-100) });
    });
  }

  private setupWebSocket(): void {
    this.wss.on("connection", (ws: WebSocket) => {
      console.log('🔌 WebSocket cliente conectado');
      this.clients.add(ws);
      
      // Enviar estado inicial
      const glpiStatus = this.glpiClient ? this.glpiClient.getSessionStatus() : { isValid: false };
      ws.send(JSON.stringify({
        type: "initial-state",
        whatsapp: this.whatsappManager.getState(),
        glpi: glpiStatus,
        logs: this.logs.slice(-50),
      }));

      ws.on("message", (data: Buffer) => {
        try {
          const message = JSON.parse(data.toString());
          if (message.type === 'ping') {
            ws.send(JSON.stringify({ type: 'pong' }));
          }
        } catch {
          // ignore invalid messages
        }
      });

      ws.on("close", () => {
        console.log('🔌 WebSocket cliente desconectado');
        this.clients.delete(ws);
      });

      ws.on("error", (err) => {
        console.error('❌ WebSocket error:', err.message);
        this.clients.delete(ws);
      });
    });
  }

  start(): void {
    this.server.listen(this.port, () => {
      console.log(`🌐 Dashboard web disponible en http://localhost:${this.port}`);
      this.log(`Servidor web iniciado en puerto ${this.port}`);
    });
  }

  private log(message: string): void {
    const timestamp = new Date().toISOString();
    const logEntry = `[${timestamp}] ${message}`;
    this.logs.push(logEntry);
    
    // Mantener solo últimos 200 logs
    if (this.logs.length > 200) {
      this.logs = this.logs.slice(-200);
    }
    
    console.log(logEntry);
    this.broadcast({ type: "log", message: logEntry });
  }

  public broadcast(data: unknown): void {
    const message = JSON.stringify(data);
    for (const client of this.clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(message);
      }
    }
  }

  // Called from WhatsApp manager events
  onWhatsAppStateChange(): void {
    this.broadcast({ type: "whatsapp-state", state: this.whatsappManager.getState() });
  }
}
