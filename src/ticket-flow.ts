import type { IncomingMessage, MediaPayload, TicketDraft } from "./types";
import { normalizeText } from "./text";
import { parseTicketText } from "./ticket-parser";
import { GlpiClient } from "./glpi";

type TicketSession = {
  draft: TicketDraft | null;
  ticketId: string | null;
  attachments: MediaPayload[];
  awaitingText: boolean;
  uploadedCount: number;
};

type TicketFlowOptions = {
  defaultCategoryId: number;
  technicianByPhone: Record<string, string>;
};

const START_COMMAND = "INICIAR TICKET";
const END_COMMAND = "FINALIZAR TICKET";

function extractDni(value: string): string | null {
  const digits = value.replace(/\D/g, "");
  return digits.length === 8 ? digits : null;
}

function buildTicketTitle(problem: string): string {
  const title = `Solicitud o incidente: ${problem}`.trim();
  return title.length > 250 ? title.slice(0, 250) : title;
}

function buildTicketContent(draft: TicketDraft): string {
  return [
    `PROBLEMA: ${draft.problema || ""}`,
    `SOLICITANTE: ${draft.solicitante || ""}`,
    `ASIGNADO: ${draft.asignado || ""}`,
  ].join("\n");
}

function buildSessionKey(message: IncomingMessage): string {
  const sender = message.senderNumber || message.senderId || "unknown";
  return `${message.chatId}:${sender}`;
}

function deriveFilename(media: MediaPayload, fallbackBase: string): string {
  if (media.filename) {
    return media.filename;
  }
  const extensionMap: Record<string, string> = {
    "image/jpeg": "jpg",
    "image/png": "png",
    "image/gif": "gif",
    "application/pdf": "pdf",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
    "application/vnd.ms-excel": "xls",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document":
      "docx",
    "application/msword": "doc",
    "text/plain": "txt",
  };
  const ext = extensionMap[media.mimetype] || "bin";
  return `${fallbackBase}.${ext}`;
}

function normalizeBase64Payload(data: string): string {
  let trimmed = data.trim();
  const prefixIndex = trimmed.indexOf("base64,");
  if (prefixIndex !== -1) {
    trimmed = trimmed.slice(prefixIndex + "base64,".length);
  }
  trimmed = trimmed.replace(/\s+/g, "");
  if (trimmed.includes("-") || trimmed.includes("_")) {
    trimmed = trimmed.replace(/-/g, "+").replace(/_/g, "/");
  }
  const padding = trimmed.length % 4;
  if (padding === 2) {
    trimmed += "==";
  } else if (padding === 3) {
    trimmed += "=";
  }
  return Buffer.from(trimmed, "base64").toString("base64");
}

export class TicketFlow {
  private sessions = new Map<string, TicketSession>();
  private glpi: GlpiClient;
  private options: TicketFlowOptions;

  constructor(glpi: GlpiClient, options: TicketFlowOptions) {
    this.glpi = glpi;
    this.options = options;
  }

  async handleMessage(message: IncomingMessage): Promise<void> {
    const normalized = normalizeText(message.body);
    const sessionKey = buildSessionKey(message);
    let session = this.sessions.get(sessionKey);
    const isStart = normalized.startsWith(START_COMMAND);
    const isEnd = normalized.startsWith(END_COMMAND);

    if (isStart) {
      session = {
        draft: null,
        ticketId: null,
        attachments: [],
        awaitingText: true,
        uploadedCount: 0,
      };
      this.sessions.set(sessionKey, session);
      await message.reply(
        "Ticket iniciado. Envia los datos (por ejemplo: SOLICITANTE: 73872028, ASIGNADO: 12345678, PROBLEMA: ...). Luego envia los archivos y termina con FINALIZAR TICKET."
      );
      if (message.hasMedia) {
        await this.handleMedia(message, session);
      }
      return;
    }

    if (!session) {
      if (isEnd) {
        await message.reply("No hay un ticket en progreso.");
      }
      return;
    }

    if (message.hasMedia) {
      await this.handleMedia(message, session);
      if (isEnd) {
        await this.finalizeSession(message, sessionKey, session);
      }
      return;
    }

    if (isEnd) {
      await this.finalizeSession(message, sessionKey, session);
      return;
    }

    await this.handleText(message, session);
  }

  private async handleText(
    message: IncomingMessage,
    session: TicketSession
  ): Promise<void> {
    const parsed = parseTicketText(message.body);
    if (!parsed) {
      if (session.awaitingText) {
        await message.reply(
          "No pude reconocer el formato. Usa SOLICITANTE, ASIGNADO y PROBLEMA, o el formato 'solicitante - tecnico => problema'."
        );
      }
      return;
    }

    session.draft = {
      solicitante: parsed.solicitante || session.draft?.solicitante,
      asignado: parsed.asignado || session.draft?.asignado,
      problema: parsed.problema || session.draft?.problema,
      rawText: parsed.rawText,
      isComplete: Boolean(
        (parsed.solicitante || session.draft?.solicitante) &&
          (parsed.problema || session.draft?.problema)
      ),
    };
    session.awaitingText = false;

    if (!session.draft.isComplete) {
      await message.reply(
        "Faltan datos. Necesito al menos SOLICITANTE y PROBLEMA."
      );
      return;
    }

    if (!session.ticketId) {
      const created = await this.tryCreateTicket(message, session);
      if (created) {
        await this.uploadPendingAttachments(session);
      }
    }
  }

  private async handleMedia(
    message: IncomingMessage,
    session: TicketSession
  ): Promise<void> {
    const media = await message.getMedia();
    if (!media) {
      await message.reply("No pude descargar el archivo adjunto.");
      return;
    }

    if (!session.ticketId) {
      session.attachments.push(media);
      if (session.awaitingText) {
        await message.reply(
          "Archivo recibido. Envia primero los datos del ticket para poder adjuntarlo."
        );
      }
      return;
    }

    const uploaded = await this.uploadAttachment(session.ticketId, media);
    if (uploaded) {
      session.uploadedCount += 1;
    }
  }

  private async finalizeSession(
    message: IncomingMessage,
    sessionKey: string,
    session: TicketSession
  ): Promise<void> {
    if (!session.draft || !session.draft.isComplete) {
      await message.reply(
        "No hay datos completos para crear el ticket. Envia SOLICITANTE y PROBLEMA."
      );
      this.sessions.delete(sessionKey);
      return;
    }

    if (!session.ticketId) {
      const created = await this.tryCreateTicket(message, session);
      if (!created) {
        return;
      }
    }

    await this.uploadPendingAttachments(session);
    await message.reply(
      session.ticketId
        ? `Ticket finalizado. ID: ${session.ticketId}${
            session.uploadedCount > 0
              ? ` (adjuntos: ${session.uploadedCount})`
              : ""
          }`
        : "Ticket finalizado."
    );
    this.sessions.delete(sessionKey);
  }

  private async tryCreateTicket(
    message: IncomingMessage,
    session: TicketSession
  ): Promise<boolean> {
    if (!session.draft) {
      return false;
    }
    if (!this.glpi.isEnabled()) {
      await message.reply("GLPI no esta configurado; ticket omitido.");
      return false;
    }

    const problem = session.draft.problema || "";
    const title = buildTicketTitle(problem);
    const content = buildTicketContent(session.draft);

    const requesterValue = session.draft.solicitante || "";
    const requesterId = await this.resolveUserId(
      message,
      requesterValue,
      "solicitante",
      true
    );
    if (!requesterId) {
      return false;
    }

    let assigneeId: string | undefined;
    const assigneeValue =
      session.draft.asignado || this.resolveTechnicianFromSender(message);
    if (assigneeValue) {
      const resolvedAssignee = await this.resolveUserId(
        message,
        assigneeValue,
        "tecnico",
        true
      );
      if (!resolvedAssignee) {
        return false;
      }
      assigneeId = resolvedAssignee;
    }

    try {
      const ticketId = await this.glpi.createTicket({
        title,
        content,
        categoryId: this.options.defaultCategoryId,
        requesterId,
        assigneeId,
      });
      if (!ticketId) {
        await message.reply("GLPI no devolvio ID de ticket.");
        return false;
      }
      session.ticketId = ticketId;
      await message.reply(`Ticket creado. ID: ${ticketId}`);
      return true;
    } catch (err) {
      const messageText = err instanceof Error ? err.message : String(err);
      await message.reply(`Error al crear ticket: ${messageText}`);
      return false;
    }
  }

  private resolveTechnicianFromSender(message: IncomingMessage): string | null {
    if (!message.senderNumber) {
      return null;
    }
    const value = this.options.technicianByPhone[message.senderNumber];
    return value ? value.trim() : null;
  }

  private async resolveUserId(
    message: IncomingMessage,
    value: string,
    role: "solicitante" | "tecnico",
    allowName = false
  ): Promise<string | null> {
    const trimmed = value.trim();
    if (!trimmed) {
      if (role === "solicitante") {
        const fallback = await this.glpi.resolveDefaultRequesterId();
        if (fallback) {
          return fallback;
        }
        await message.reply("Falta SOLICITANTE.");
      }
      return null;
    }

    const dni = extractDni(trimmed);
    if (dni) {
      try {
        const candidates = await this.glpi.findUsersByDni(dni);
        if (candidates.length === 1) {
          return candidates[0].id;
        }
        if (candidates.length === 0) {
          await message.reply(`No se encontro ${role} con DNI ${dni}.`);
        } else {
          await message.reply(
            `Hay mas de un ${role} con DNI ${dni}. Envia mas informacion.`
          );
        }
        return null;
      } catch (err) {
        const messageText = err instanceof Error ? err.message : String(err);
        await message.reply(`Error al buscar DNI: ${messageText}`);
        return null;
      }
    }

    if (!allowName) {
      await message.reply(
        `El ${role} debe enviarse como DNI para asignacion exacta.`
      );
      return null;
    }

    const tokens = trimmed.split(/\s+/).filter(Boolean);
    if (role === "solicitante") {
      if (tokens.length < 2) {
        await message.reply("Para el solicitante usa DNI o nombre y apellido.");
        return null;
      }
      const candidates = await this.glpi.findUsersByName(trimmed, true);
      if (candidates.length === 1) {
        return candidates[0].id;
      }
      if (candidates.length === 0) {
        await message.reply(
          "No se encontro solicitante con ese nombre. Envia DNI."
        );
        return null;
      }
      await message.reply(
        "Hay varios solicitantes con ese nombre. Envia DNI para identificarlo."
      );
      return null;
    }

    const strict = tokens.length >= 2;
    const candidates = await this.glpi.findUsersByName(trimmed, strict);
    if (candidates.length === 1) {
      return candidates[0].id;
    }
    if (candidates.length === 0) {
      await message.reply(
        `No se encontro ${role} con nombre '${trimmed}'. Envia DNI.`
      );
      return null;
    }
    await message.reply(
      `Hay varios ${role} con ese nombre. Envia DNI para identificarlo.`
    );
    return null;
  }

  private async uploadPendingAttachments(
    session: TicketSession
  ): Promise<void> {
    if (!session.ticketId || session.attachments.length === 0) {
      return;
    }
    const attachments = [...session.attachments];
    session.attachments = [];
    for (const media of attachments) {
      const uploaded = await this.uploadAttachment(session.ticketId, media);
      if (uploaded) {
        session.uploadedCount += 1;
      }
    }
  }

  private async uploadAttachment(
    ticketId: string,
    media: MediaPayload
  ): Promise<boolean> {
    const filename = deriveFilename(media, `whatsapp-${Date.now().toString()}`);
    try {
      const sanitizedBase64 = normalizeBase64Payload(media.data);
      const sizeBytes = Buffer.byteLength(sanitizedBase64, "base64");
      await this.glpi.addDocumentToTicket(ticketId, {
        name: filename,
        filename,
        mime: media.mimetype,
        base64: sanitizedBase64,
      });
      console.log(
        `Adjunto agregado al ticket ${ticketId}: ${filename} (${sizeBytes} bytes)`
      );
      return true;
    } catch (err) {
      const messageText = err instanceof Error ? err.message : String(err);
      console.error(`Error al adjuntar archivo: ${messageText}`);
      return false;
    }
  }
}
