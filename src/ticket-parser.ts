import type { TicketDraft } from "./types";
import { normalizeTemplateKey } from "./text";

const KEY_MAP: Record<string, "solicitante" | "asignado" | "problema"> = {
  SOLICITANTE: "solicitante",
  "DNI SOLICITANTE": "solicitante",
  "SOLICITANTE DNI": "solicitante",
  USUARIO: "solicitante",
  "USUARIO SOLICITANTE": "solicitante",
  ASIGNADO: "asignado",
  TECNICO: "asignado",
  RESPONSABLE: "asignado",
  PROBLEMA: "problema",
  DESCRIPCION: "problema",
};

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

function buildDraft(
  solicitante?: string,
  asignado?: string,
  problema?: string,
  rawText = ""
): TicketDraft | null {
  const hasAny = Boolean(solicitante || asignado || problema);
  if (!hasAny) {
    return null;
  }
  const isComplete = Boolean(solicitante && problema);
  return {
    solicitante,
    asignado,
    problema,
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
    const key = normalizeTemplateKey(rawKey);
    const mapped = KEY_MAP[key];
    if (mapped) {
      data[mapped] = value;
    }
  }

  return buildDraft(data.solicitante, data.asignado, data.problema, body);
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

  return buildDraft(solicitante, asignado, problema, body);
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
    return buildDraft(first, undefined, second, body);
  }
  if (secondDni && !firstDni) {
    return buildDraft(second, undefined, first, body);
  }

  const firstLen = first.length;
  const secondLen = second.length;
  if (firstLen >= secondLen) {
    return buildDraft(second, undefined, first, body);
  }
  return buildDraft(first, undefined, second, body);
}

export function parseTicketText(body: string): TicketDraft | null {
  return (
    parseKeyValueTemplate(body) ??
    parseInlineTemplate(body) ??
    parseLooseDashTemplate(body)
  );
}
