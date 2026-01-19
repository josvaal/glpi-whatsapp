import type { TicketDraft } from "./types";
import { normalizeTemplateKey } from "./text";

type TicketField =
  | "solicitante"
  | "asignado"
  | "problema"
  | "categoria"
  | "nombre"
  | "dni"
  | "celular"
  | "correo"
  | "cargo"
  | "dependencia"
  | "piso";

const KEY_MAP: Record<string, TicketField> = {
  SOLICITANTE: "solicitante",
  USUARIO: "solicitante",
  "USUARIO SOLICITANTE": "solicitante",
  ASIGNADO: "asignado",
  TECNICO: "asignado",
  RESPONSABLE: "asignado",
  PROBLEMA: "problema",
  DESCRIPCION: "problema",
  SOLICITUD: "problema",
  INCIDENTE: "problema",
  "SOLICITUD O INCIDENTE": "problema",
  "SOLICITUD INCIDENTE": "problema",
  CATEGORIA: "categoria",
  "CATEGORIA PROBLEMA": "categoria",
  SISTEMA: "categoria",
  BIEN: "categoria",
  "SISTEMA O BIEN": "categoria",
  "SISTEMA BIEN": "categoria",
  NOMBRE: "nombre",
  NOMBRES: "nombre",
  "NOMBRE COMPLETO": "nombre",
  APELLIDOS: "nombre",
  "APELLIDOS Y NOMBRES": "nombre",
  DNI: "dni",
  "DNI SOLICITANTE": "dni",
  "SOLICITANTE DNI": "dni",
  DOCUMENTO: "dni",
  "DOCUMENTO IDENTIDAD": "dni",
  "DOC IDENTIDAD": "dni",
  "N DNI": "dni",
  "NRO DNI": "dni",
  "NRO DE DNI": "dni",
  "NUMERO DNI": "dni",
  "NUMERO DE DNI": "dni",
  CELULAR: "celular",
  CEL: "celular",
  TELEFONO: "celular",
  "TELEFONO CELULAR": "celular",
  "TELEFONO MOVIL": "celular",
  MOVIL: "celular",
  CORREO: "correo",
  EMAIL: "correo",
  "E MAIL": "correo",
  MAIL: "correo",
  "CORREO ELECTRONICO": "correo",
  CARGO: "cargo",
  PUESTO: "cargo",
  FUNCION: "cargo",
  DEPENDENCIA: "dependencia",
  OFICINA: "dependencia",
  AREA: "dependencia",
  UNIDAD: "dependencia",
  SEDE: "dependencia",
  PISO: "piso",
};

function normalizeTicketKey(value: string): string {
  return normalizeTemplateKey(value)
    .replace(/[\u00BA\u00B0]/g, " ")
    .replace(/[^A-Z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function splitByDash(value: string): string[] {
  return value
    .split(/\s*-\s*/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

function looksLikeDni(value: string): boolean {
  const digits = value.replace(/\D/g, "");
  return digits.length === 8;
}

const PROBLEM_HINTS = new Set([
  "NO",
  "SIN",
  "ERROR",
  "FALLA",
  "FALLANDO",
  "PROBLEMA",
  "SOLICITO",
  "SOLICITUD",
  "SOLICITAR",
  "IMPRIME",
  "IMPRIMIR",
  "IMPRESORA",
  "CORREO",
  "EMAIL",
  "OUTLOOK",
  "INTERNET",
  "RED",
  "VPN",
  "SISTEMA",
  "APLICACION",
  "APP",
  "PC",
  "CPU",
  "LAPTOP",
  "NOTEBOOK",
  "MONITOR",
  "ESCANER",
  "SCANNER",
  "CLAVE",
  "CONTRASENA",
  "PASSWORD",
  "ACCESO",
  "INGRESAR",
  "ENTRAR",
  "CUENTA",
  "BLOQUEO",
  "BLOQUEADO",
  "BLOQUEADA",
  "LENTO",
  "LENTA",
  "ACTUALIZAR",
  "ACTUALIZACION",
  "INSTALAR",
  "INSTALACION",
  "CAMBIO",
  "CAMBIAR",
  "URGENTE",
]);

function tokenizeWords(value: string): string[] {
  return normalizeTemplateKey(value)
    .split(/\s+/)
    .map((token) => token.trim())
    .filter(Boolean);
}

function hasProblemHints(value: string): boolean {
  const tokens = tokenizeWords(value);
  return tokens.some((token) => PROBLEM_HINTS.has(token));
}

function looksLikeName(value: string): boolean {
  const tokens = tokenizeWords(value);
  if (tokens.length < 2 || tokens.length > 6) {
    return false;
  }
  if (hasProblemHints(value)) {
    return false;
  }
  return tokens.every((token) => /^[A-Z]+$/.test(token));
}

function looksLikeProblem(value: string): boolean {
  if (/\d/.test(value)) {
    return true;
  }
  return hasProblemHints(value);
}

function buildDraft(
  data: Partial<TicketDraft>,
  rawText = ""
): TicketDraft | null {
  const hasAny = Object.entries(data).some(
    ([key, value]) =>
      key !== "rawText" && key !== "isComplete" && Boolean(value)
  );
  if (!hasAny) {
    return null;
  }

  const solicitante = data.solicitante;
  const inferredDni =
    data.dni || (solicitante && looksLikeDni(solicitante) ? solicitante : undefined);
  const inferredNombre =
    data.nombre || (!inferredDni && solicitante ? solicitante : undefined);
  const finalSolicitante = solicitante ?? inferredDni ?? inferredNombre;
  const isComplete = Boolean(finalSolicitante && data.problema);

  return {
    ...data,
    solicitante: finalSolicitante,
    dni: inferredDni,
    nombre: inferredNombre,
    rawText,
    isComplete,
  };
}

export function parseKeyValueTemplate(body: string): TicketDraft | null {
  const lines = body
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (lines.length === 0) {
    return null;
  }

  const data: Partial<TicketDraft> = {};
  for (const line of lines) {
    const index = line.indexOf(":");
    if (index === -1) {
      continue;
    }
    const rawKey = line.slice(0, index);
    const value = line.slice(index + 1).trim();
    if (!rawKey || !value) {
      continue;
    }
    const key = normalizeTicketKey(rawKey);
    const mapped = KEY_MAP[key];
    if (!mapped) {
      continue;
    }
    if (mapped === "dni") {
      data.dni = value;
      data.solicitante = value;
      continue;
    }
    if (mapped === "nombre") {
      data.nombre = value;
      if (!data.solicitante) {
        data.solicitante = value;
      }
      continue;
    }
    data[mapped] = value;
  }

  return buildDraft(data, body);
}

export function parseInlineTemplate(body: string): TicketDraft | null {
  const arrowIndex = body.indexOf("=>");
  if (arrowIndex === -1) {
    return null;
  }
  const left = body.slice(0, arrowIndex).trim();
  const right = body.slice(arrowIndex + 2).trim();
  if (!left && !right) {
    return null;
  }

  const leftParts = splitByDash(left);
  const rightParts = splitByDash(right);

  let solicitante = leftParts[0];
  let asignado = leftParts.length > 1 ? leftParts[1] : undefined;
  let problema = right;

  if (!solicitante && rightParts.length >= 2) {
    problema = rightParts[0];
    solicitante = rightParts[1];
    if (!asignado && rightParts.length >= 3) {
      asignado = rightParts[2];
    }
  }

  return buildDraft({ solicitante, asignado, problema }, body);
}

export function parseLooseDashTemplate(body: string): TicketDraft | null {
  if (body.includes("=>")) {
    return null;
  }
  const parts = splitByDash(body);
  if (parts.length !== 2) {
    return null;
  }
  const [first, second] = parts;
  if (!first || !second) {
    return null;
  }

  const firstDni = looksLikeDni(first);
  const secondDni = looksLikeDni(second);

  if (firstDni && !secondDni) {
    return buildDraft({ solicitante: first, problema: second }, body);
  }
  if (secondDni && !firstDni) {
    return buildDraft({ solicitante: second, problema: first }, body);
  }

  const firstNameLike = looksLikeName(first);
  const secondNameLike = looksLikeName(second);
  if (firstNameLike && !secondNameLike) {
    return buildDraft({ solicitante: first, problema: second }, body);
  }
  if (secondNameLike && !firstNameLike) {
    return buildDraft({ solicitante: second, problema: first }, body);
  }

  const firstProblemLike = looksLikeProblem(first);
  const secondProblemLike = looksLikeProblem(second);
  if (firstProblemLike && !secondProblemLike) {
    return buildDraft({ solicitante: second, problema: first }, body);
  }
  if (secondProblemLike && !firstProblemLike) {
    return buildDraft({ solicitante: first, problema: second }, body);
  }

  const firstLen = first.length;
  const secondLen = second.length;
  if (firstLen >= secondLen) {
    return buildDraft({ solicitante: second, problema: first }, body);
  }
  return buildDraft({ solicitante: first, problema: second }, body);
}

export function parseTicketText(body: string): TicketDraft | null {
  return (
    parseKeyValueTemplate(body) ??
    parseInlineTemplate(body) ??
    parseLooseDashTemplate(body)
  );
}
