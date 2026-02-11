import type {
  GlpiUserCandidate,
  IncomingMessage,
  IncomingPollVote,
  MediaPayload,
  TicketDraft,
} from "./types";
import { normalizeText } from "./text";
import { parseTicketText } from "./ticket-parser";
import { GlpiClient } from "./glpi";

type PendingSelection = {
  role: "solicitante" | "tecnico";
  candidates: GlpiUserCandidate[];
  pollMessageId: string | null;
  awaitingPoll: boolean;
};

type TicketSession = {
  draft: TicketDraft | null;
  ticketId: string | null;
  attachments: MediaPayload[];
  awaitingText: boolean;
  uploadedCount: number;
  resolvedRequesterId: string | null;
  resolvedAssigneeId: string | null;
  pendingSelection: PendingSelection | null;
};

type TicketFlowOptions = {
  defaultCategoryId: number;
  defaultCategoryName?: string;
  technicianByPhone: Record<string, string>;
};

type MessageContext = {
  senderId: string | null;
  senderNumber: string | null;
  senderLabel?: string | null;
  reply: (text: string) => Promise<void>;
  sendPoll?: (
    title: string,
    options: string[],
    allowMultiple?: boolean
  ) => Promise<string | null>;
  react?: (emoji: string) => Promise<void>;
};

type CommandSpec = {
  command: string;
  normalized: string;
};

const START_COMMANDS = buildCommandSpecs(["INICIAR TICKET", "OPEN TCK"]);
const END_COMMANDS = buildCommandSpecs(["FINALIZAR TICKET", "CLOSE TCK"]);
const MAX_SELECTION_CANDIDATES = 10;

function buildCommandSpecs(commands: string[]): CommandSpec[] {
  return commands.map((command) => ({
    command,
    normalized: normalizeText(command),
  }));
}

function matchCommand(
  normalizedBody: string,
  commands: CommandSpec[]
): CommandSpec | null {
  for (const command of commands) {
    if (normalizedBody.startsWith(command.normalized)) {
      return command;
    }
  }
  return null;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function normalizePhone(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }
  const digits = value.replace(/\D+/g, "");
  return digits || null;
}

function normalizeName(value: string): string {
  return normalizeText(value)
    .replace(/[^A-Z ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function buildCommandRegex(command: string): RegExp {
  const tokens = command.trim().split(/\s+/).map(escapeRegExp);
  const pattern = tokens.join("\\s+");
  return new RegExp(`^\\s*${pattern}\\s*[:\\-]?\\s*`, "i");
}

function stripCommandBody(body: string, command: string): string {
  const regex = buildCommandRegex(command);
  return body.replace(regex, "").trim();
}

function formatCandidateName(candidate: GlpiUserCandidate): string {
  const first = candidate.firstname?.trim() || "";
  const last = candidate.realname?.trim() || "";
  const fullName = [first, last].filter(Boolean).join(" ").trim();
  return fullName || candidate.login || candidate.id;
}

function buildCandidateLabel(candidate: GlpiUserCandidate): string {
  const base = formatCandidateName(candidate);
  if (candidate.login && candidate.login !== base) {
    return `${base} (login: ${candidate.login})`;
  }
  return base;
}

function buildCandidateOptionNames(
  candidates: GlpiUserCandidate[]
): string[] {
  const baseNames = candidates.map((candidate) => formatCandidateName(candidate));
  const normalized = baseNames.map((name) => normalizeText(name));
  const counts = new Map<string, number>();
  for (const name of normalized) {
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return candidates.map((candidate, index) => {
    const base = baseNames[index];
    if ((counts.get(normalized[index]) ?? 0) > 1) {
      return buildCandidateLabel(candidate);
    }
    return base;
  });
}

function buildCandidateMatchKeys(candidate: GlpiUserCandidate): string[] {
  const first = candidate.firstname?.trim() || "";
  const last = candidate.realname?.trim() || "";
  const fullName = [first, last].filter(Boolean).join(" ").trim();
  const reversed = [last, first].filter(Boolean).join(" ").trim();
  const login = candidate.login?.trim() || "";
  const keys = [fullName, reversed, login].filter(Boolean);
  return Array.from(new Set(keys.map((value) => normalizeText(value))));
}

function matchCandidateInput(
  input: string,
  candidates: GlpiUserCandidate[]
): GlpiUserCandidate | null {
  const trimmed = input.trim();
  if (!trimmed) {
    return null;
  }
  const index = Number(trimmed);
  if (Number.isInteger(index) && index >= 1 && index <= candidates.length) {
    return candidates[index - 1];
  }
  const normalized = normalizeText(trimmed);
  for (const candidate of candidates) {
    const keys = buildCandidateMatchKeys(candidate);
    if (keys.includes(normalized)) {
      return candidate;
    }
  }
  return null;
}

async function tryReact(
  message: MessageContext,
  emoji: string
): Promise<void> {
  if (!message.react) {
    return;
  }
  await message.react(emoji);
}

function extractDni(value: string): string | null {
  const digits = value.replace(/\D/g, "");
  return digits.length === 8 ? digits : null;
}

function buildTicketTitle(problem: string): string {
  const title = `Solicitud o incidente: ${problem}`.trim();
  return title.length > 250 ? title.slice(0, 250) : title;
}

function buildTicketContent(draft: TicketDraft): string {
  const labelStyle = "font-weight: bold; color: navy;";
  const solicitanteValue = draft.solicitante || "";
  const dniValue = draft.dni || extractDni(solicitanteValue) || "";
  const nombreValue =
    draft.nombre || (!dniValue && solicitanteValue ? solicitanteValue : "");

  const problema = escapeHtml(draft.problema || "");
  const categoria = escapeHtml(draft.categoria || "");
  const nombre = escapeHtml(nombreValue);
  const dni = escapeHtml(dniValue);
  const celular = escapeHtml(draft.celular || "");
  const correo = escapeHtml(draft.correo || "");
  const cargo = escapeHtml(draft.cargo || "");
  const dependencia = escapeHtml(draft.dependencia || "");
  const piso = escapeHtml(draft.piso || "");

  return [
    `<p><span style="${labelStyle}">Solicitud o incidente:</span> ${problema}</p>`,
    `<p><span style="${labelStyle}">Sistema o bien:</span> ${categoria}</p>`,
    `<p><span style="${labelStyle}">Nombre:</span> ${nombre}</p>`,
    `<p><span style="${labelStyle}">N\u00B0 DNI:</span> ${dni}</p>`,
    `<p><span style="${labelStyle}">Celular:</span> ${celular}</p>`,
    `<p><span style="${labelStyle}">Correo:</span> ${correo}</p>`,
    `<p><span style="${labelStyle}">Cargo:</span> ${cargo}</p>`,
    `<p><span style="${labelStyle}">Dependencia:</span> ${dependencia}</p>`,
    `<p><span style="${labelStyle}">Piso:</span> ${piso}</p>`,
  ].join("\n");
}

function buildSessionKey(message: IncomingMessage): string {
  return buildSessionKeyFrom(
    message.chatId,
    message.senderNumber,
    message.senderId
  );
}

function buildSessionKeyFrom(
  chatId: string,
  senderNumber: string | null,
  senderId: string | null
): string {
  const sender = senderNumber || senderId || "unknown";
  return `${chatId}:${sender}`;
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
  private technicianNameEntries: Array<{ name: string; phone: string }>;

  constructor(glpi: GlpiClient, options: TicketFlowOptions) {
    this.glpi = glpi;
    this.options = options;
    this.technicianNameEntries = buildTechnicianNameEntries(
      options.technicianByPhone
    );
  }

  async handleMessage(message: IncomingMessage): Promise<void> {
    const normalized = normalizeText(message.body);
    const sessionKey = buildSessionKey(message);
    let session = this.sessions.get(sessionKey);
    const startCommand = matchCommand(normalized, START_COMMANDS);
    const endCommand = matchCommand(normalized, END_COMMANDS);
    const isStart = Boolean(startCommand);
    const isEnd = Boolean(endCommand);
    const isAuthorized = this.isAuthorizedSender(message);

    if (!isAuthorized) {
      if (session) {
        this.sessions.delete(sessionKey);
      }
      if (isStart) {
        await message.reply(this.buildUnauthorizedMessage(message));
      }
      return;
    }

    if (isStart) {
      session = {
        draft: null,
        ticketId: null,
        attachments: [],
        awaitingText: true,
        uploadedCount: 0,
        resolvedRequesterId: null,
        resolvedAssigneeId: null,
        pendingSelection: null,
      };
      this.sessions.set(sessionKey, session);
      await tryReact(message, "🟢");
      const startBody = startCommand
        ? stripCommandBody(message.body, startCommand.command)
        : "";
      if (!startBody) {
        await message.reply(
          "Ticket iniciado. Envia los datos (por ejemplo: SOLICITANTE: 73872028, ASIGNADO: 12345678, PROBLEMA: ...). Luego envia los archivos y termina con FINALIZAR TICKET o CLOSE TCK."
        );
      } else {
        await this.handleText(message, session, startBody);
      }
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

    if (session.pendingSelection) {
      if (message.hasMedia) {
        await this.handleMedia(message, session);
      }
      if (session.pendingSelection.awaitingPoll) {
        if (isEnd) {
          await message.reply(
            "Antes de finalizar, responde la encuesta para seleccionar el solicitante o tecnico."
          );
        }
        return;
      }
      if (session.pendingSelection.pollMessageId) {
        if (isEnd) {
          await message.reply(
            "Antes de finalizar, responde la encuesta para seleccionar el solicitante o tecnico."
          );
        }
        return;
      }
      const selectionBody = endCommand
        ? stripCommandBody(message.body, endCommand.command)
        : message.body;
      const resolved = await this.resolvePendingSelection(
        message,
        session,
        selectionBody
      );
      if (!resolved) {
        if (isEnd) {
          await message.reply(
            "Antes de finalizar, selecciona el solicitante o tecnico indicado."
          );
        }
        return;
      }
      if (session.draft?.isComplete && !session.ticketId) {
        const created = await this.tryCreateTicket(message, session);
        if (created) {
          await this.uploadPendingAttachments(session);
        }
      }
      if (isEnd) {
        await this.finalizeSession(message, sessionKey, session);
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

  async handlePollVote(vote: IncomingPollVote): Promise<void> {
    const sessionKey = buildSessionKeyFrom(
      vote.chatId,
      vote.senderNumber,
      vote.senderId
    );
    const session = this.sessions.get(sessionKey);
    if (!session || !session.pendingSelection) {
      return;
    }
    const pending = session.pendingSelection;
    if (!pending.pollMessageId) {
      return;
    }
    if (!vote.pollMessageId || pending.pollMessageId !== vote.pollMessageId) {
      return;
    }
    const candidate = this.pickCandidateFromPollVote(pending, vote);
    if (!candidate) {
      const roleLabel =
        pending.role === "solicitante" ? "solicitante" : "tecnico";
      await vote.reply(
        `No pude identificar al ${roleLabel}. Responde nuevamente la encuesta.`
      );
      return;
    }
    this.applyResolvedCandidate(session, pending.role, candidate);
    session.pendingSelection = null;
    const roleLabel =
      pending.role === "solicitante" ? "Solicitante" : "Tecnico";
    await vote.reply(
      `${roleLabel} seleccionado: ${formatCandidateName(candidate)}.`
    );
    if (session.draft?.isComplete && !session.ticketId) {
      const created = await this.tryCreateTicket(vote, session);
      if (created) {
        await this.uploadPendingAttachments(session);
      }
    }
  }

  private async handleText(
    message: IncomingMessage,
    session: TicketSession,
    bodyOverride?: string
  ): Promise<void> {
    const parsed = parseTicketText(bodyOverride ?? message.body);
    if (!parsed) {
      if (session.awaitingText) {
        await tryReact(message, "⚠️");
        await message.reply(
          "No pude reconocer el formato. Usa SOLICITANTE, ASIGNADO y PROBLEMA, o el formato 'solicitante - tecnico => problema'."
        );
      }
      return;
    }

    if (parsed.solicitante && parsed.solicitante !== session.draft?.solicitante) {
      session.resolvedRequesterId = null;
    }
    if (parsed.asignado && parsed.asignado !== session.draft?.asignado) {
      session.resolvedAssigneeId = null;
    }

    const mergedSolicitante = parsed.solicitante || session.draft?.solicitante;
    const mergedProblema = parsed.problema || session.draft?.problema;

    session.draft = {
      solicitante: mergedSolicitante,
      asignado: parsed.asignado || session.draft?.asignado,
      problema: mergedProblema,
      categoria: parsed.categoria || session.draft?.categoria,
      nombre: parsed.nombre || session.draft?.nombre,
      dni: parsed.dni || session.draft?.dni,
      celular: parsed.celular || session.draft?.celular,
      correo: parsed.correo || session.draft?.correo,
      cargo: parsed.cargo || session.draft?.cargo,
      dependencia: parsed.dependencia || session.draft?.dependencia,
      piso: parsed.piso || session.draft?.piso,
      rawText: parsed.rawText,
      isComplete: Boolean(mergedSolicitante && mergedProblema),
    };
    if (!session.draft.categoria && this.options.defaultCategoryName) {
      session.draft.categoria = this.options.defaultCategoryName;
    }
    session.awaitingText = false;

    if (!session.draft.isComplete) {
      await tryReact(message, "⚠️");
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
      await tryReact(message, "❌");
      await message.reply("No pude descargar el archivo adjunto.");
      return;
    }

    if (!session.ticketId) {
      session.attachments.push(media);
      await tryReact(message, "📎");
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
      await tryReact(message, "📎");
    } else {
      await tryReact(message, "❌");
    }
  }

  private async finalizeSession(
    message: IncomingMessage,
    sessionKey: string,
    session: TicketSession
  ): Promise<void> {
    if (!session.draft || !session.draft.isComplete) {
      await tryReact(message, "⚠️");
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
    await tryReact(message, "✅");
    this.sessions.delete(sessionKey);
  }

  private async tryCreateTicket(
    message: MessageContext,
    session: TicketSession
  ): Promise<boolean> {
    if (!session.draft) {
      return false;
    }
    if (!this.glpi.isEnabled()) {
      await tryReact(message, "❌");
      await message.reply("GLPI no esta configurado; ticket omitido.");
      return false;
    }

    const requesterValue = session.draft.solicitante || "";
    const requesterId = await this.resolveUserId(
      message,
      session,
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
        session,
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
      const problem = session.draft.problema || "";
      const title = buildTicketTitle(problem);
      const content = buildTicketContent(session.draft);
      const ticketId = await this.glpi.createTicket({
        title,
        content,
        categoryId: this.options.defaultCategoryId,
        requesterId,
        assigneeId,
      });
      if (!ticketId) {
        await tryReact(message, "❌");
        await message.reply("GLPI no devolvio ID de ticket.");
        return false;
      }
      session.ticketId = ticketId;
      await message.reply(`Ticket creado. ID: ${ticketId}`);
      await tryReact(message, "🎫");
      return true;
    } catch (err) {
      const messageText = err instanceof Error ? err.message : String(err);
      await tryReact(message, "❌");
      await message.reply(`Error al crear ticket: ${messageText}`);
      return false;
    }
  }

  private resolveTechnicianFromSender(message: MessageContext): string | null {
    const senderNumber = this.resolveSenderNumber(message);
    if (!senderNumber) {
      return null;
    }
    const value = this.options.technicianByPhone[senderNumber];
    return value ? value.trim() : null;
  }

  private isAuthorizedSender(message: MessageContext): boolean {
    return Boolean(this.resolveSenderNumber(message));
  }

  private buildUnauthorizedMessage(message: MessageContext): string {
    const resolved = this.resolveSenderNumber(message);
    const fallbackNumber = normalizePhone(message.senderNumber);
    const mention = resolved || fallbackNumber;
    if (mention) {
      return `Lo lamento @${mention} tienes que estar en la lista de tecnicos.`;
    }
    const label = message.senderLabel?.trim();
    return `Lo lamento ${label || "@mencion"} tienes que estar en la lista de tecnicos.`;
  }

  private resolveSenderNumber(message: MessageContext): string | null {
    const directNumber = normalizePhone(message.senderNumber);
    if (directNumber && this.options.technicianByPhone[directNumber]) {
      return directNumber;
    }

    const label = message.senderLabel || "";
    const labelNumber = normalizePhone(label);
    if (labelNumber && this.options.technicianByPhone[labelNumber]) {
      return labelNumber;
    }

    const normalizedLabel = normalizeName(label);
    if (!normalizedLabel) {
      return null;
    }

    const exact = this.technicianNameEntries.find(
      (entry) => entry.name === normalizedLabel
    );
    if (exact) {
      return exact.phone;
    }

    for (const entry of this.technicianNameEntries) {
      if (normalizedLabel.includes(entry.name) || entry.name.includes(normalizedLabel)) {
        return entry.phone;
      }
    }

    return null;
  }

  private async resolveUserId(
    message: MessageContext,
    session: TicketSession,
    value: string,
    role: "solicitante" | "tecnico",
    allowName = false
  ): Promise<string | null> {
    const cached =
      role === "solicitante"
        ? session.resolvedRequesterId
        : session.resolvedAssigneeId;
    if (cached) {
      return cached;
    }

    const trimmed = value.trim();
    if (!trimmed) {
      if (role === "solicitante") {
        const fallback = await this.glpi.resolveDefaultRequesterId();
        if (fallback) {
          session.resolvedRequesterId = fallback;
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
        return await this.handleCandidateResults(
          message,
          session,
          role,
          candidates,
          `No se encontro ${role} con DNI ${dni}.`
        );
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
      let candidates = await this.glpi.findUsersByName(trimmed, true);
      if (candidates.length === 0) {
        candidates = await this.glpi.findUsersByName(trimmed, false);
      }
      return await this.handleCandidateResults(
        message,
        session,
        role,
        candidates,
        "No se encontro solicitante con ese nombre. Envia DNI."
      );
    }

    const strict = tokens.length >= 2;
    let candidates = await this.glpi.findUsersByName(trimmed, strict);
    if (candidates.length === 0 && strict) {
      candidates = await this.glpi.findUsersByName(trimmed, false);
    }
    return await this.handleCandidateResults(
      message,
      session,
      role,
      candidates,
      `No se encontro ${role} con nombre '${trimmed}'. Envia DNI.`
    );
  }

  private async handleCandidateResults(
    message: MessageContext,
    session: TicketSession,
    role: "solicitante" | "tecnico",
    candidates: GlpiUserCandidate[],
    notFoundMessage: string
  ): Promise<string | null> {
    if (candidates.length === 0) {
      await tryReact(message, "❌");
      await message.reply(notFoundMessage);
      return null;
    }

    if (candidates.length === 1) {
      this.applyResolvedCandidate(session, role, candidates[0]);
      return candidates[0].id;
    }

    await this.promptCandidateSelection(message, session, role, candidates);
    return null;
  }

  private async promptCandidateSelection(
    message: MessageContext,
    session: TicketSession,
    role: "solicitante" | "tecnico",
    candidates: GlpiUserCandidate[]
  ): Promise<void> {
    if (session.pendingSelection) {
      return;
    }
    const limited = candidates.slice(0, MAX_SELECTION_CANDIDATES);
    const roleLabel = role === "solicitante" ? "solicitante" : "tecnico";
    const optionNames = buildCandidateOptionNames(limited);
    session.pendingSelection = {
      role,
      candidates: limited,
      pollMessageId: null,
      awaitingPoll: true,
    };
    await tryReact(message, "🔎");
    const pollMessageId = message.sendPoll
      ? await message.sendPoll(
          `Selecciona ${roleLabel} del ticket`,
          optionNames,
          false
        )
      : null;
    session.pendingSelection.pollMessageId = pollMessageId ?? null;
    session.pendingSelection.awaitingPoll = false;
    if (pollMessageId) {
      return;
    }
    const lines = limited.map(
      (candidate, index) => `${index + 1}) ${buildCandidateLabel(candidate)}`
    );
    const suffix =
      candidates.length > limited.length
        ? `\n(Mostrando ${limited.length} de ${candidates.length}. Si no esta en la lista, envia el DNI o un nombre mas especifico.)`
        : "";
    await message.reply(
      `No pude enviar la encuesta. Responde con el nombre completo o el numero de la lista:\n${lines.join(
        "\n"
      )}${suffix}`
    );
  }

  private async resolvePendingSelection(
    message: IncomingMessage,
    session: TicketSession,
    selectionBody: string
  ): Promise<boolean> {
    const pending = session.pendingSelection;
    if (!pending) {
      return false;
    }
    const input = selectionBody.trim();
    if (!input) {
      return false;
    }
    const candidate = matchCandidateInput(input, pending.candidates);
    if (!candidate) {
      const roleLabel = pending.role === "solicitante" ? "solicitante" : "tecnico";
      await tryReact(message, "⚠️");
      await message.reply(
        `No pude identificar al ${roleLabel}. Responde con el nombre completo exacto o el numero de la lista.`
      );
      return false;
    }
    this.applyResolvedCandidate(session, pending.role, candidate);
    session.pendingSelection = null;
    const roleLabel = pending.role === "solicitante" ? "Solicitante" : "Tecnico";
    await message.reply(`${roleLabel} seleccionado: ${formatCandidateName(candidate)}.`);
    await tryReact(message, "✅");
    return true;
  }

  private applyResolvedCandidate(
    session: TicketSession,
    role: "solicitante" | "tecnico",
    candidate: GlpiUserCandidate
  ): void {
    const name = formatCandidateName(candidate);
    if (role === "solicitante") {
      session.resolvedRequesterId = candidate.id;
      if (session.draft) {
        session.draft.solicitante = name;
        if (!session.draft.nombre) {
          session.draft.nombre = name;
        }
        if (!session.draft.dni) {
          const dni = extractDni(candidate.dni || "") || extractDni(candidate.login || "");
          if (dni) {
            session.draft.dni = dni;
          }
        }
        if (!session.draft.correo && candidate.email) {
          session.draft.correo = candidate.email;
        }
        if (!session.draft.celular) {
          const mobile = candidate.mobile?.trim();
          const phone = candidate.phone?.trim();
          if (mobile) {
            session.draft.celular = mobile;
          } else if (phone) {
            session.draft.celular = phone;
          }
        }
        if (!session.draft.cargo) {
          const cargo = candidate.category?.trim() || candidate.title?.trim();
          if (cargo) {
            session.draft.cargo = cargo;
          }
        }
        if (!session.draft.dependencia) {
          const dependencia = candidate.location?.trim() || candidate.entity?.trim();
          if (dependencia) {
            session.draft.dependencia = dependencia;
          }
        }
        if (!session.draft.piso && candidate.floor) {
          session.draft.piso = candidate.floor;
        }
      }
      return;
    }
    session.resolvedAssigneeId = candidate.id;
    if (session.draft) {
      session.draft.asignado = name;
    }
  }

  private pickCandidateFromPollVote(
    pending: PendingSelection,
    vote: IncomingPollVote
  ): GlpiUserCandidate | null {
    if (vote.selectedOptionIds.length > 0) {
      const index = vote.selectedOptionIds[0];
      if (Number.isInteger(index) && index >= 0 && index < pending.candidates.length) {
        return pending.candidates[index];
      }
    }
    if (vote.selectedOptionNames.length > 0) {
      return matchCandidateInput(vote.selectedOptionNames[0], pending.candidates);
    }
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

function buildTechnicianNameEntries(
  map: Record<string, string>
): Array<{ name: string; phone: string }> {
  const entries: Array<{ name: string; phone: string }> = [];
  for (const [phone, label] of Object.entries(map)) {
    const normalizedName = normalizeName(label);
    if (!normalizedName) {
      continue;
    }
    entries.push({ name: normalizedName, phone });
  }
  return entries;
}

