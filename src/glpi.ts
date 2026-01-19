import type { GlpiConfig } from "./config";
import type { GlpiUserCandidate } from "./types";
import { normalizeText } from "./text";

const MAX_SCAN_MATCHES = 10;

type GlpiRequestOptions = {
  method: string;
  body?: unknown;
  useProfile?: boolean;
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

type GlpiProfile = {
  id: string;
  name: string;
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
  private profileId: string;
  private profileName: string;
  private searchProfileId: string;
  private searchProfileName: string;
  private enabled: boolean;
  private sessionToken: string | null = null;
  private sessionPromise: Promise<string> | null = null;
  private profileSessionToken: string | null = null;
  private profileSessionPromise: Promise<string> | null = null;
  private searchProfileSessionToken: string | null = null;
  private searchProfileSessionPromise: Promise<string> | null = null;
  private defaultRequesterId: string | null = null;
  private cachedProfiles: GlpiProfile[] | null = null;
  private detectedDniFieldIds: string[] | null = null;
  private detectedLoginFieldId: string | null = null;
  private detectedEntityFieldId: string | null | undefined = undefined;
  private searchOptionsCache: Record<string, unknown> | null = null;
  private readonly userEntityId = "26";

  constructor(config: GlpiConfig) {
    this.baseUrl = config.baseUrl;
    this.defaultRequester = config.defaultRequester;
    this.profileId = config.profileId;
    this.profileName = config.profileName;
    this.searchProfileId = config.searchProfileId;
    this.searchProfileName = config.searchProfileName;
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

  private normalizeProfileName(value: string): string {
    return normalizeText(value)
      .replace(/[^A-Z0-9 ]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  private parseProfiles(response: unknown): GlpiProfile[] {
    const records: Array<Record<string, unknown>> = [];
    const addRecord = (item: unknown): void => {
      if (item && typeof item === "object") {
        records.push(item as Record<string, unknown>);
      }
    };
    const addFromArray = (value: unknown): void => {
      if (Array.isArray(value)) {
        value.forEach(addRecord);
      }
    };

    if (Array.isArray(response)) {
      response.forEach(addRecord);
    } else if (response && typeof response === "object") {
      const obj = response as Record<string, unknown>;
      if ("id" in obj || "profiles_id" in obj || "name" in obj) {
        addRecord(obj);
      }
      for (const key of ["profiles", "myprofiles", "data", "profile"]) {
        addFromArray(obj[key]);
      }
      for (const [key, value] of Object.entries(obj)) {
        if (typeof value === "string" && /^\d+$/.test(key)) {
          records.push({ id: key, name: value });
          continue;
        }
        if (value && typeof value === "object" && !Array.isArray(value)) {
          const nested = value as Record<string, unknown>;
          if ("id" in nested || "profiles_id" in nested || "name" in nested) {
            addRecord(nested);
          }
          for (const [nestedKey, nestedValue] of Object.entries(nested)) {
            if (typeof nestedValue === "string" && /^\d+$/.test(nestedKey)) {
              records.push({ id: nestedKey, name: nestedValue });
            }
          }
        }
      }
    }

    const parsed = records
      .map((record) => {
        const rawId = record.id ?? record["profiles_id"] ?? record["0"];
        const id = String(rawId ?? "").trim();
        const rawName =
          record.name ?? record["profiles_name"] ?? record["1"] ?? record["name"];
        const name = String(rawName ?? "").trim();
        if (!id || !name) {
          return null;
        }
        return { id, name };
      })
      .filter((item): item is GlpiProfile => Boolean(item));

    const byId = new Map<string, GlpiProfile>();
    for (const profile of parsed) {
      if (!byId.has(profile.id)) {
        byId.set(profile.id, profile);
      }
    }
    return Array.from(byId.values());
  }

  private async getMyProfiles(): Promise<GlpiProfile[]> {
    const response = await this.request("getMyProfiles", {
      method: "GET",
    });
    return this.parseProfiles(response);
  }

  private async resolveProfileIdFor(
    profileId: string,
    profileName: string
  ): Promise<string | null> {
    if (profileId) {
      return profileId;
    }
    const targetName = profileName.trim();
    if (!targetName) {
      return null;
    }
    const profiles = await this.getMyProfiles();
    this.cachedProfiles = profiles;
    const targetNormalized = this.normalizeProfileName(targetName);
    const exact = profiles.find(
      (profile) => this.normalizeProfileName(profile.name) === targetNormalized
    );
    if (exact) {
      return exact.id;
    }
    const partial = profiles.filter((profile) =>
      this.normalizeProfileName(profile.name).includes(targetNormalized)
    );
    if (partial.length === 1) {
      return partial[0].id;
    }
    return null;
  }

  private async ensureProfileSession(): Promise<string> {
    if (!this.profileId && !this.profileName) {
      return this.ensureSession();
    }
    if (this.profileSessionToken) {
      return this.profileSessionToken;
    }
    if (this.profileSessionPromise) {
      return this.profileSessionPromise;
    }
    this.profileSessionPromise = (async () => {
      const targetId = await this.resolveProfileIdFor(
        this.profileId,
        this.profileName
      );
      if (!targetId) {
        const targetName = this.profileName.trim();
        const label = targetName ? `perfil '${targetName}'` : "perfil configurado";
        const available =
          this.cachedProfiles?.map((profile) => profile.name).filter(Boolean) ?? [];
        const details =
          available.length > 0
            ? ` Perfiles disponibles: ${available.join(", ")}.`
            : "";
        throw new Error(`No se encontro el ${label} en GLPI.${details}`);
      }
      const token = await this.initSession();
      const numericId = Number(targetId);
      const payloadId = Number.isNaN(numericId) ? targetId : numericId;
      const { response, payload } = await this.requestWithSession(
        token,
        "changeActiveProfile",
        {
          method: "POST",
          body: { profiles_id: payloadId },
        }
      );
      if (!response.ok) {
        throw new Error(
          `GLPI changeActiveProfile fallo (${response.status}): ${
            payload.text || "sin cuerpo"
          }`
        );
      }
      this.profileSessionToken = token;
      return token;
    })().finally(() => {
      this.profileSessionPromise = null;
    });
    return this.profileSessionPromise;
  }

  private async ensureSearchProfileSession(): Promise<string> {
    if (!this.searchProfileId && !this.searchProfileName) {
      return this.ensureSession();
    }
    if (this.searchProfileSessionToken) {
      return this.searchProfileSessionToken;
    }
    if (this.searchProfileSessionPromise) {
      return this.searchProfileSessionPromise;
    }
    this.searchProfileSessionPromise = (async () => {
      const targetId = await this.resolveProfileIdFor(
        this.searchProfileId,
        this.searchProfileName
      );
      if (!targetId) {
        const targetName = this.searchProfileName.trim();
        const label = targetName
          ? `perfil '${targetName}'`
          : "perfil de busqueda";
        const available =
          this.cachedProfiles?.map((profile) => profile.name).filter(Boolean) ?? [];
        const details =
          available.length > 0
            ? ` Perfiles disponibles: ${available.join(", ")}.`
            : "";
        throw new Error(`No se encontro el ${label} en GLPI.${details}`);
      }
      const token = await this.initSession();
      const numericId = Number(targetId);
      const payloadId = Number.isNaN(numericId) ? targetId : numericId;
      const { response, payload } = await this.requestWithSession(
        token,
        "changeActiveProfile",
        {
          method: "POST",
          body: { profiles_id: payloadId },
        }
      );
      if (!response.ok) {
        throw new Error(
          `GLPI changeActiveProfile fallo (${response.status}): ${
            payload.text || "sin cuerpo"
          }`
        );
      }
      this.searchProfileSessionToken = token;
      return token;
    })().finally(() => {
      this.searchProfileSessionPromise = null;
    });
    return this.searchProfileSessionPromise;
  }

  private async requestWithSession(
    sessionToken: string,
    path: string,
    options: GlpiRequestOptions
  ): Promise<{ response: Response; payload: { text: string; json?: unknown } }> {
    if (!this.enabled || !this.baseUrl) {
      throw new Error("GLPI no esta configurado.");
    }
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
    return { response, payload };
  }

  private async request(
    path: string,
    options: GlpiRequestOptions,
    retry = true
  ): Promise<unknown> {
    const useProfile = Boolean(options.useProfile);
    const sessionToken = useProfile
      ? await this.ensureProfileSession()
      : await this.ensureSession();
    const { response, payload } = await this.requestWithSession(
      sessionToken,
      path,
      options
    );
    const text = payload.text;
    if (!response.ok) {
      const invalidSession =
        text.includes("ERROR_SESSION_TOKEN_INVALID") ||
        text.includes("ERROR_SESSION_EXPIRED") ||
        response.status === 401;
      if (invalidSession && retry) {
        if (useProfile) {
          this.profileSessionToken = null;
          this.profileSessionPromise = null;
        } else {
          this.sessionToken = null;
          this.sessionPromise = null;
        }
        this.cachedProfiles = null;
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

  private async requestForSearch(
    path: string,
    options: GlpiRequestOptions,
    retry = true
  ): Promise<unknown> {
    if (!this.searchProfileId && !this.searchProfileName) {
      return this.request(path, options, retry);
    }
    const sessionToken = await this.ensureSearchProfileSession();
    const { response, payload } = await this.requestWithSession(
      sessionToken,
      path,
      options
    );
    const text = payload.text;
    if (!response.ok) {
      const invalidSession =
        text.includes("ERROR_SESSION_TOKEN_INVALID") ||
        text.includes("ERROR_SESSION_EXPIRED") ||
        response.status === 401;
      if (invalidSession && retry) {
        this.searchProfileSessionToken = null;
        this.searchProfileSessionPromise = null;
        this.cachedProfiles = null;
        return this.requestForSearch(path, options, false);
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
    useProfile = false,
    retry = true
  ): Promise<unknown> {
    if (!this.enabled || !this.baseUrl) {
      throw new Error("GLPI no esta configurado.");
    }
    const sessionToken = useProfile
      ? await this.ensureProfileSession()
      : await this.ensureSession();
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
        if (useProfile) {
          this.profileSessionToken = null;
          this.profileSessionPromise = null;
        } else {
          this.sessionToken = null;
          this.sessionPromise = null;
        }
        this.cachedProfiles = null;
        return this.requestMultipart(path, form, useProfile, false);
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
    let usedEntityFilter = false;
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
        usedEntityFilter = true;
      }
    }

    const buildParams = (
      criteriaList: GlpiSearchCriterion[]
    ): Array<[string, string]> => {
      const params: Array<[string, string]> = [];
      criteriaList.forEach((item, index) => {
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
      return params;
    };

    const query = this.buildQueryString(buildParams(criteriaWithEntity));
    const response = await this.requestForSearch(`search/User?${query}`, {
      method: "GET",
    });
    const parsed = this.parseUserCandidates(response);
    if (parsed.length > 0 || !usedEntityFilter) {
      return parsed;
    }

    const fallbackQuery = this.buildQueryString(buildParams(criteria));
    const fallbackResponse = await this.requestForSearch(
      `search/User?${fallbackQuery}`,
      {
        method: "GET",
      }
    );
    return this.parseUserCandidates(fallbackResponse);
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

  private normalizeNameValue(value: string): string {
    return normalizeText(value)
      .replace(/[^A-Z0-9 ]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  private buildCandidateSearchText(candidate: GlpiUserCandidate): string {
    const parts = [candidate.firstname, candidate.realname, candidate.login]
      .map((value) => value?.trim())
      .filter(Boolean) as string[];
    return this.normalizeNameValue(parts.join(" "));
  }

  private filterCandidatesByName(
    candidates: GlpiUserCandidate[],
    query: string
  ): GlpiUserCandidate[] {
    const tokens = this.normalizeNameValue(query)
      .split(/\s+/)
      .filter(Boolean);
    if (tokens.length === 0) {
      return candidates;
    }
    return candidates.filter((candidate) => {
      const haystack = this.buildCandidateSearchText(candidate);
      if (!haystack) {
        return false;
      }
      return tokens.every((token) => haystack.includes(token));
    });
  }

  private async scanUsersByName(
    query: string,
    maxRange = 1000,
    pageSize = 50
  ): Promise<GlpiUserCandidate[]> {
    const matches: GlpiUserCandidate[] = [];
    for (let start = 0; start <= maxRange; start += pageSize) {
      const end = start + pageSize - 1;
      const range = `${start}-${end}`;
      const page = await this.searchUsersByCriteria([], range, "contains");
      const filtered = this.filterCandidatesByName(page, query);
      if (filtered.length > 0) {
        matches.push(...filtered);
      }
      if (page.length < pageSize) {
        break;
      }
      if (matches.length >= MAX_SCAN_MATCHES) {
        break;
      }
    }
    return this.dedupeCandidates(matches);
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
    const response = await this.requestForSearch("listSearchOptions/User", {
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
        const response = await this.requestForSearch(`User?${query}`, {
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
    const primaryRange = "0-50";
    const extendedRange = "0-500";
    let unfilteredCriteria: GlpiSearchCriterion[] | null = null;

    const handleMatches = (
      matches: GlpiUserCandidate[],
      criteria: GlpiSearchCriterion[]
    ): GlpiUserCandidate[] | null => {
      const filtered = this.filterCandidatesByName(matches, trimmed);
      if (filtered.length > 0) {
        return filtered;
      }
      if (matches.length > 0 && !unfilteredCriteria) {
        unfilteredCriteria = criteria;
      }
      return null;
    };

    const attempts = this.buildNameSearchAttempts(trimmed, searchType);
    for (const criteria of attempts) {
      const matches = await this.searchUsersByCriteria(
        criteria,
        primaryRange,
        searchType
      );
      const filtered = handleMatches(matches, criteria);
      if (filtered) {
        return this.dedupeCandidates(filtered);
      }
    }

    const singleAttempts = this.buildSingleFieldNameAttempts(
      trimmed,
      searchType
    );
    for (const criteria of singleAttempts) {
      const matches = await this.searchUsersByCriteria(
        criteria,
        primaryRange,
        searchType
      );
      const filtered = handleMatches(matches, criteria);
      if (filtered) {
        return this.dedupeCandidates(filtered);
      }
    }

    const loginFieldId = await this.getLoginFieldId();
    const loginMatches = await this.searchUsersByCriteria(
      [{ field: loginFieldId, value: trimmed }],
      primaryRange,
      searchType
    );
    const filteredLogin = handleMatches(loginMatches, [
      { field: loginFieldId, value: trimmed },
    ]);
    if (filteredLogin) {
      return this.dedupeCandidates(filteredLogin);
    }

    if (unfilteredCriteria) {
      const extendedMatches = await this.searchUsersByCriteria(
        unfilteredCriteria,
        extendedRange,
        searchType
      );
      const filtered = this.filterCandidatesByName(extendedMatches, trimmed);
      if (filtered.length > 0) {
        return this.dedupeCandidates(filtered);
      }
    }

    try {
      const query = this.buildQueryString([["searchText", trimmed]]);
      const response = await this.requestForSearch(`User?${query}`, {
        method: "GET",
      });
      const results = this.parseUserCandidates(response);
      const filtered = this.filterCandidatesByName(results, trimmed);
      return this.dedupeCandidates(filtered);
    } catch {
      // Ignore searchText fallback errors.
    }

    const scanned = await this.scanUsersByName(trimmed);
    return this.dedupeCandidates(scanned);
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
      useProfile: true,
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
      useProfile: true,
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
        return await this.requestMultipart("Document", form, true);
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
      useProfile: true,
    });
  }
}
