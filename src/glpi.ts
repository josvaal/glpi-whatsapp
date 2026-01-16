import type { GlpiConfig } from "./config";
import type { GlpiUserCandidate } from "./types";
import { normalizeText } from "./text";

type GlpiRequestOptions = {
  method: string;
  body?: unknown;
};

type GlpiSearchCriterion = {
  field: string;
  value: string;
  link?: string;
  searchType?: string;
};

type NameSplit = {
  realname: string;
  firstname: string;
};

export type GlpiTicketInput = {
  title: string;
  content: string;
  categoryId: number;
  requesterId: string;
  assigneeId?: string;
};

export type GlpiDocumentInput = {
  name: string;
  filename: string;
  mime: string;
  base64: string;
};

export class GlpiClient {
  private baseUrl: string | null;
  private authHeader: string;
  private defaultRequester: string;
  private dniFieldIds: string[];
  private enabled: boolean;
  private sessionToken: string | null = null;
  private sessionPromise: Promise<string> | null = null;
  private defaultRequesterId: string | null = null;
  private detectedDniFieldIds: string[] | null = null;
  private detectedLoginFieldId: string | null = null;
  private detectedEntityFieldId: string | null | undefined = undefined;
  private searchOptionsCache: Record<string, unknown> | null = null;
  private readonly userEntityId = "26";

  constructor(config: GlpiConfig) {
    this.baseUrl = config.baseUrl;
    this.defaultRequester = config.defaultRequester;
    const invalidIds = config.dniFieldIds.filter((id) => !/^\d+$/.test(id));
    if (invalidIds.length > 0) {
      console.warn(
        `GLPI_DNI_FIELD_IDS contiene valores invalidos: ${invalidIds.join(", ")}`
      );
    }
    this.dniFieldIds = config.dniFieldIds.filter((id) => /^\d+$/.test(id));
    this.enabled = config.enabled;
    this.authHeader = this.enabled
      ? `Basic ${Buffer.from(`${config.user}:${config.password}`).toString(
          "base64"
        )}`
      : "";

    if (!this.enabled) {
      console.warn(
        "GLPI deshabilitado: faltan GLPI_BASE_URL, GLPI_USER o GLPI_PASSWORD."
      );
    }
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  private async readResponsePayload(
    response: Response
  ): Promise<{ text: string; json?: unknown }> {
    const text = await response.text();
    if (!text) {
      return { text: "" };
    }
    try {
      return { text, json: JSON.parse(text) };
    } catch {
      return { text };
    }
  }

  private async initSession(): Promise<string> {
    if (!this.enabled || !this.baseUrl) {
      throw new Error("GLPI no esta configurado.");
    }
    const response = await fetch(
      `${this.baseUrl}/initSession?get_full_session=true`,
      {
        method: "GET",
        headers: {
          Authorization: this.authHeader,
          Accept: "application/json",
        },
      }
    );

    const payload = await this.readResponsePayload(response);
    if (!response.ok) {
      throw new Error(
        `GLPI initSession fallo (${response.status}): ${
          payload.text || "sin cuerpo"
        }`
      );
    }
    const data = payload.json as { session_token?: string } | undefined;
    const sessionToken = data?.session_token;
    if (!sessionToken) {
      throw new Error("GLPI initSession no devolvio session_token.");
    }
    return sessionToken;
  }

  private async ensureSession(): Promise<string> {
    if (this.sessionToken) {
      return this.sessionToken;
    }
    if (!this.sessionPromise) {
      this.sessionPromise = this.initSession()
        .then((token) => {
          this.sessionToken = token;
          return token;
        })
        .finally(() => {
          this.sessionPromise = null;
        });
    }
    return this.sessionPromise;
  }

  private async request(
    path: string,
    options: GlpiRequestOptions,
    retry = true
  ): Promise<unknown> {
    if (!this.enabled || !this.baseUrl) {
      throw new Error("GLPI no esta configurado.");
    }
    const sessionToken = await this.ensureSession();
    const headers: Record<string, string> = {
      "Session-Token": sessionToken,
      Accept: "application/json",
    };
    let body: string | undefined;
    if (options.body !== undefined) {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(options.body);
    }

    const response = await fetch(`${this.baseUrl}/${path}`, {
      method: options.method,
      headers,
      body,
    });

    const payload = await this.readResponsePayload(response);
    const text = payload.text;
    if (!response.ok) {
      const invalidSession =
        text.includes("ERROR_SESSION_TOKEN_INVALID") ||
        text.includes("ERROR_SESSION_EXPIRED") ||
        response.status === 401;
      if (invalidSession && retry) {
        this.sessionToken = null;
        return this.request(path, options, false);
      }
      throw new Error(
        `GLPI ${options.method} ${path} fallo (${response.status}): ${
          text || "sin cuerpo"
        }`
      );
    }

    return payload.json ?? text;
  }

  private async requestMultipart(
    path: string,
    form: FormData,
    retry = true
  ): Promise<unknown> {
    if (!this.enabled || !this.baseUrl) {
      throw new Error("GLPI no esta configurado.");
    }
    const sessionToken = await this.ensureSession();
    const headers: Record<string, string> = {
      "Session-Token": sessionToken,
      Accept: "application/json",
    };

    const response = await fetch(`${this.baseUrl}/${path}`, {
      method: "POST",
      headers,
      body: form,
    });

    const payload = await this.readResponsePayload(response);
    const text = payload.text;
    if (!response.ok) {
      const invalidSession =
        text.includes("ERROR_SESSION_TOKEN_INVALID") ||
        text.includes("ERROR_SESSION_EXPIRED") ||
        response.status === 401;
      if (invalidSession && retry) {
        this.sessionToken = null;
        return this.requestMultipart(path, form, false);
      }
      throw new Error(
        `GLPI POST ${path} fallo (${response.status}): ${text || "sin cuerpo"}`
      );
    }

    return payload.json ?? text;
  }

  private buildQueryString(params: Array<[string, string]>): string {
    return params
      .map(
        ([key, value]) =>
          `${encodeURIComponent(key)}=${encodeURIComponent(value)}`
      )
      .join("&");
  }

  private parseUserCandidates(response: unknown): GlpiUserCandidate[] {
    const data = Array.isArray(response)
      ? response
      : typeof response === "object" && response && "data" in response
        ? (response as { data?: unknown }).data
        : null;
    if (!Array.isArray(data)) {
      return [];
    }
    return data
      .map((item) => {
        const record = item as Record<string, unknown>;
        const rawId = record.id ?? record["2"] ?? record["0"];
        const id = String(rawId ?? "").trim();
        if (!/^\d+$/.test(id)) {
          return null;
        }
        return {
          id,
          login: String(
            record["1"] ?? record.name ?? record.login ?? record.username ?? ""
          ).trim(),
          firstname: String(record["9"] ?? record.firstname ?? "").trim(),
          realname: String(record["34"] ?? record.realname ?? "").trim(),
        };
      })
      .filter((item): item is GlpiUserCandidate => Boolean(item));
  }

  private dedupeCandidates(
    candidates: GlpiUserCandidate[]
  ): GlpiUserCandidate[] {
    const byId = new Map<string, GlpiUserCandidate>();
    for (const candidate of candidates) {
      byId.set(candidate.id, candidate);
    }
    return Array.from(byId.values());
  }

  private async searchUsersByCriteria(
    criteria: GlpiSearchCriterion[],
    range = "0-50",
    searchType = "contains"
  ): Promise<GlpiUserCandidate[]> {
    const entityFieldId = this.userEntityId
      ? await this.getUserEntityFieldId()
      : null;
    let criteriaWithEntity = criteria;
    if (entityFieldId && this.userEntityId) {
      const normalizedEntity = this.userEntityId.trim();
      if (normalizedEntity) {
        const rest = criteria.map((item) => {
          if (item.link) {
            return item;
          }
          return { ...item, link: "AND" };
        });
        criteriaWithEntity = [
          {
            field: entityFieldId,
            value: normalizedEntity,
            searchType: "equals",
          },
          ...rest,
        ];
      }
    }

    const params: Array<[string, string]> = [];
    criteriaWithEntity.forEach((item, index) => {
      if (item.link) {
        params.push([`criteria[${index}][link]`, item.link]);
      }
      params.push([`criteria[${index}][field]`, item.field]);
      params.push([
        `criteria[${index}][searchtype]`,
        item.searchType ?? searchType,
      ]);
      params.push([`criteria[${index}][value]`, item.value]);
    });
    params.push(["forcedisplay[0]", "2"]);
    params.push(["forcedisplay[1]", "1"]);
    params.push(["forcedisplay[2]", "9"]);
    params.push(["forcedisplay[3]", "34"]);
    params.push(["range", range]);

    const query = this.buildQueryString(params);
    const response = await this.request(`search/User?${query}`, {
      method: "GET",
    });
    return this.parseUserCandidates(response);
  }

  private splitFullName(fullName: string): NameSplit[] {
    const tokens = fullName.split(/\s+/).filter(Boolean);
    const splits: NameSplit[] = [];
    if (tokens.length >= 4) {
      splits.push({
        realname: tokens.slice(0, 2).join(" "),
        firstname: tokens.slice(2).join(" "),
      });
      splits.push({
        realname: tokens.slice(0, tokens.length - 2).join(" "),
        firstname: tokens.slice(-2).join(" "),
      });
    } else if (tokens.length === 3) {
      splits.push({
        realname: tokens.slice(0, 2).join(" "),
        firstname: tokens.slice(2).join(" "),
      });
      splits.push({
        realname: tokens.slice(0, 1).join(" "),
        firstname: tokens.slice(1).join(" "),
      });
    } else if (tokens.length === 2) {
      splits.push({ realname: tokens[0], firstname: tokens[1] });
    }
    const seen = new Set<string>();
    return splits.filter((split) => {
      const key = `${split.realname}|${split.firstname}`.toUpperCase();
      if (seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    });
  }

  private tokenizeName(value: string): string[] {
    return value
      .split(/\s+/)
      .map((part) => part.trim())
      .filter(Boolean);
  }

  private buildNameSearchAttempts(
    value: string,
    searchType: string
  ): GlpiSearchCriterion[][] {
    const attempts: GlpiSearchCriterion[][] = [];
    const seen = new Set<string>();
    const addAttempt = (criteria: GlpiSearchCriterion[]): void => {
      const key = criteria
        .map(
          (item) =>
            `${item.field}:${normalizeText(item.value)}:${
              item.link ?? ""
            }:${item.searchType ?? searchType}`
        )
        .join("|");
      if (seen.has(key)) {
        return;
      }
      seen.add(key);
      attempts.push(criteria);
    };

    const tokens = this.tokenizeName(value);
    if (tokens.length < 2) {
      return attempts;
    }

    for (let i = 1; i < tokens.length; i += 1) {
      const first = tokens.slice(0, i).join(" ");
      const last = tokens.slice(i).join(" ");
      addAttempt([
        { field: "9", value: first },
        { field: "34", value: last, link: "AND" },
      ]);
      addAttempt([
        { field: "9", value: last },
        { field: "34", value: first, link: "AND" },
      ]);
    }

    if (tokens.length <= 6) {
      const total = 1 << tokens.length;
      for (let mask = 1; mask < total - 1; mask += 1) {
        const firstTokens: string[] = [];
        const lastTokens: string[] = [];
        for (let i = 0; i < tokens.length; i += 1) {
          if (mask & (1 << i)) {
            firstTokens.push(tokens[i]);
          } else {
            lastTokens.push(tokens[i]);
          }
        }
        if (firstTokens.length === 0 || lastTokens.length === 0) {
          continue;
        }
        addAttempt([
          { field: "9", value: firstTokens.join(" ") },
          { field: "34", value: lastTokens.join(" "), link: "AND" },
        ]);
      }
    }

    return attempts;
  }

  private buildSingleFieldNameAttempts(
    value: string,
    searchType: string
  ): GlpiSearchCriterion[][] {
    const attempts: GlpiSearchCriterion[][] = [];
    const seen = new Set<string>();
    const addAttempt = (criteria: GlpiSearchCriterion[]): void => {
      const key = criteria
        .map(
          (item) =>
            `${item.field}:${normalizeText(item.value)}:${
              item.link ?? ""
            }:${item.searchType ?? searchType}`
        )
        .join("|");
      if (seen.has(key)) {
        return;
      }
      seen.add(key);
      attempts.push(criteria);
    };

    const trimmed = value.trim();
    if (trimmed) {
      addAttempt([{ field: "9", value: trimmed }]);
      addAttempt([{ field: "34", value: trimmed }]);
    }

    const tokens = this.tokenizeName(value);
    for (const token of tokens) {
      addAttempt([{ field: "9", value: token }]);
      addAttempt([{ field: "34", value: token }]);
    }

    return attempts;
  }

  private async getUserSearchOptions(): Promise<Record<string, unknown>> {
    if (this.searchOptionsCache) {
      return this.searchOptionsCache;
    }
    const response = await this.request("listSearchOptions/User", {
      method: "GET",
    });
    const options =
      typeof response === "object" && response
        ? (response as Record<string, unknown>)
        : {};
    this.searchOptionsCache = options;
    return options;
  }

  private async getDniFieldIds(): Promise<string[]> {
    if (this.dniFieldIds.length > 0) {
      return this.dniFieldIds;
    }
    if (this.detectedDniFieldIds) {
      return this.detectedDniFieldIds;
    }

    const options = await this.getUserSearchOptions();
    const matches: string[] = [];
    for (const [key, value] of Object.entries(options)) {
      if (!value || typeof value !== "object") {
        continue;
      }
      if (!/^\d+$/.test(key)) {
        continue;
      }
      const record = value as Record<string, unknown>;
      const name = String(record.name ?? "").trim();
      const table = String(record.table ?? "").trim().toLowerCase();
      if (table.includes("glpi_documents_items")) {
        continue;
      }
      const nameNorm = normalizeText(name);
      if (
        nameNorm.includes("DNI") ||
        nameNorm.includes("DOCUMENTO") ||
        nameNorm.includes("ADMINISTRATIVO")
      ) {
        matches.push(key);
      }
    }
    this.detectedDniFieldIds = matches;
    return matches;
  }

  private async getLoginFieldId(): Promise<string> {
    if (this.detectedLoginFieldId) {
      return this.detectedLoginFieldId;
    }
    const options = await this.getUserSearchOptions();
    let loginFieldId: string | null = null;
    for (const [key, value] of Object.entries(options)) {
      if (!value || typeof value !== "object") {
        continue;
      }
      if (!/^\d+$/.test(key)) {
        continue;
      }
      const record = value as Record<string, unknown>;
      const name = String(record.name ?? "").trim();
      const nameNorm = normalizeText(name);
      if (nameNorm.includes("LOGIN") || nameNorm.includes("USUARIO")) {
        loginFieldId = key;
        break;
      }
    }
    if (!loginFieldId || !/^\d+$/.test(loginFieldId)) {
      loginFieldId = "1";
    }
    this.detectedLoginFieldId = loginFieldId;
    return loginFieldId;
  }

  private async getUserEntityFieldId(): Promise<string | null> {
    if (this.detectedEntityFieldId !== undefined) {
      return this.detectedEntityFieldId;
    }
    const options = await this.getUserSearchOptions();
    let entityFieldId: string | null = null;
    for (const [key, value] of Object.entries(options)) {
      if (!value || typeof value !== "object") {
        continue;
      }
      if (!/^\d+$/.test(key)) {
        continue;
      }
      const record = value as Record<string, unknown>;
      const name = String(record.name ?? "").trim();
      const table = String(record.table ?? "").trim().toLowerCase();
      const field = String(record.field ?? "").trim().toLowerCase();
      const nameNorm = normalizeText(name);
      if (
        table.includes("glpi_entities") ||
        field.includes("entities_id") ||
        nameNorm.includes("ENTIDAD") ||
        nameNorm.includes("ENTITY")
      ) {
        entityFieldId = key;
        break;
      }
    }
    if (!entityFieldId && this.userEntityId) {
      console.warn(
        "No se encontro el campo de entidad en GLPI; se omite el filtro por entidad."
      );
    }
    this.detectedEntityFieldId = entityFieldId;
    return entityFieldId;
  }

  private isInvalidFieldIdError(messageText: string): boolean {
    const normalized = normalizeText(messageText);
    return normalized.includes("ID ERRONEO");
  }

  async findUsersByDni(dni: string): Promise<GlpiUserCandidate[]> {
    const cleaned = dni.replace(/\D/g, "");
    if (!cleaned) {
      return [];
    }
    const fieldIds = await this.getDniFieldIds();
    let results: GlpiUserCandidate[] = [];

    if (fieldIds.length > 0) {
      for (const fieldId of fieldIds) {
        try {
          const matches = await this.searchUsersByCriteria(
            [{ field: fieldId, value: cleaned }],
            "0-10",
            "equals"
          );
          results = results.concat(matches);
        } catch (err) {
          const messageText = err instanceof Error ? err.message : String(err);
          if (this.isInvalidFieldIdError(messageText)) {
            throw new Error(
              "GLPI_DNI_FIELD_IDS contiene un campo invalido. Actualiza el ID del campo DNI."
            );
          }
          throw err;
        }
      }
      results = this.dedupeCandidates(results);
    }

    if (results.length === 0 && fieldIds.length > 0) {
      for (const fieldId of fieldIds) {
        try {
          const matches = await this.searchUsersByCriteria(
            [{ field: fieldId, value: cleaned }],
            "0-10",
            "contains"
          );
          results = results.concat(matches);
        } catch (err) {
          const messageText = err instanceof Error ? err.message : String(err);
          if (this.isInvalidFieldIdError(messageText)) {
            throw new Error(
              "GLPI_DNI_FIELD_IDS contiene un campo invalido. Actualiza el ID del campo DNI."
            );
          }
          throw err;
        }
      }
      results = this.dedupeCandidates(results);
    }

    if (results.length === 0) {
      const loginFieldId = await this.getLoginFieldId();
      const loginMatches = await this.searchUsersByCriteria(
        [{ field: loginFieldId, value: cleaned }],
        "0-10",
        "equals"
      );
      results = results.concat(loginMatches);
      results = this.dedupeCandidates(results);
    }

    if (results.length === 0) {
      const loginFieldId = await this.getLoginFieldId();
      const loginMatches = await this.searchUsersByCriteria(
        [{ field: loginFieldId, value: cleaned }],
        "0-10",
        "contains"
      );
      results = results.concat(loginMatches);
      results = this.dedupeCandidates(results);
    }

    if (results.length === 0) {
      try {
        const query = this.buildQueryString([["searchText", cleaned]]);
        const response = await this.request(`User?${query}`, {
          method: "GET",
        });
        results = results.concat(this.parseUserCandidates(response));
        results = this.dedupeCandidates(results);
      } catch {
        // Ignore fallback errors; keep empty results.
      }
    }

    return results;
  }

  async findUsersByName(name: string, strict = false): Promise<GlpiUserCandidate[]> {
    const trimmed = name.trim();
    if (!trimmed) {
      return [];
    }
    const searchType = strict ? "equals" : "contains";

    const attempts = this.buildNameSearchAttempts(trimmed, searchType);
    for (const criteria of attempts) {
      const matches = await this.searchUsersByCriteria(
        criteria,
        "0-50",
        searchType
      );
      if (matches.length > 0) {
        return this.dedupeCandidates(matches);
      }
    }

    const singleAttempts = this.buildSingleFieldNameAttempts(
      trimmed,
      searchType
    );
    for (const criteria of singleAttempts) {
      const matches = await this.searchUsersByCriteria(
        criteria,
        "0-50",
        searchType
      );
      if (matches.length > 0) {
        return this.dedupeCandidates(matches);
      }
    }

    const loginFieldId = await this.getLoginFieldId();
    return this.searchUsersByCriteria(
      [{ field: loginFieldId, value: trimmed }],
      "0-50",
      searchType
    );
  }

  async resolveDefaultRequesterId(): Promise<string | null> {
    if (!this.defaultRequester) {
      return null;
    }
    if (this.defaultRequesterId) {
      return this.defaultRequesterId;
    }
    const matches = await this.findUsersByName(this.defaultRequester, false);
    if (matches.length === 1) {
      this.defaultRequesterId = matches[0].id;
      return this.defaultRequesterId;
    }
    return null;
  }

  async createTicket(input: GlpiTicketInput): Promise<string | null> {
    if (!this.enabled) {
      return null;
    }

    const payload: Record<string, unknown> = {
      name: input.title,
      content: input.content,
      itilcategories_id: input.categoryId,
      _users_id_requester: Number.isNaN(Number(input.requesterId))
        ? input.requesterId
        : Number(input.requesterId),
    };
    if (input.assigneeId) {
      payload._users_id_assign = Number.isNaN(Number(input.assigneeId))
        ? input.assigneeId
        : Number(input.assigneeId);
    }

    const response = await this.request("Ticket", {
      method: "POST",
      body: { input: payload },
    });

    const data = response as Record<string, unknown> | null;
    const ticketId = data?.id ?? data?.message ?? null;
    return ticketId ? String(ticketId) : null;
  }

  async addDocumentToTicket(
    ticketId: string,
    document: GlpiDocumentInput
  ): Promise<string | null> {
    if (!this.enabled) {
      return null;
    }
    const docResponse = await this.createDocument(document);

    const docData = docResponse as Record<string, unknown> | null;
    const documentId = docData?.id ?? null;
    if (!documentId) {
      throw new Error("GLPI no devolvio ID de documento.");
    }

    await this.request("Document_Item", {
      method: "POST",
      body: {
        input: {
          documents_id: Number(documentId),
          items_id: Number(ticketId),
          itemtype: "Ticket",
        },
      },
    });

    return String(documentId);
  }

  private async createDocument(
    document: GlpiDocumentInput
  ): Promise<unknown> {
    const canMultipart =
      typeof FormData !== "undefined" && typeof Blob !== "undefined";
    if (canMultipart) {
      try {
        const bytes = Buffer.from(document.base64, "base64");
        const form = new FormData();
        const manifest = {
          input: {
            name: document.name,
            filename: document.filename,
            mime: document.mime,
          },
        };
        form.append("uploadManifest", JSON.stringify(manifest));
        const blob = new Blob([bytes], { type: document.mime });
        form.append("filename", blob, document.filename);
        return await this.requestMultipart("Document", form);
      } catch (err) {
        const messageText = err instanceof Error ? err.message : String(err);
        console.warn(
          `Fallo upload multipart, reintentando base64: ${messageText}`
        );
      }
    }

    return this.request("Document", {
      method: "POST",
      body: {
        input: {
          name: document.name,
          filename: document.filename,
          mime: document.mime,
          base64: document.base64,
        },
      },
    });
  }
}
