import fs from "fs";
import path from "path";

import dotenv from "dotenv";

dotenv.config();

export type WhatsappConfig = {
  groupName: string;
  sessionDir: string;
  headless: boolean;
  executablePath?: string;
  clientId?: string;
};

export type GlpiConfig = {
  baseUrl: string | null;
  user: string;
  password: string;
  defaultRequester: string;
  dniFieldIds: string[];
  profileId: string;
  profileName: string;
  searchProfileId: string;
  searchProfileName: string;
  enabled: boolean;
};

export type TechnicianInfo = {
  name: string;
  phone: string;
  glpiId: string;
};

export type AppConfig = {
  whatsapp: WhatsappConfig;
  glpi: GlpiConfig;
  categoriesPath: string;
  defaultCategoryId: number;
  techniciansByPhone: Record<string, TechnicianInfo>;
};

function envBool(value: string | undefined, defaultValue: boolean): boolean {
  if (value === undefined || value === null || value === "") {
    return defaultValue;
  }
  return ["1", "true", "yes", "y", "on"].includes(value.trim().toLowerCase());
}

function normalizeGlpiBaseUrl(value: string | undefined): string | null {
  if (!value) {
    return null;
  }
  let base = value.trim();
  if (!base) {
    return null;
  }
  base = base.replace(/\/+$/, "");
  if (!base.endsWith("/apirest.php")) {
    base = `${base}/apirest.php`;
  }
  return base;
}

function normalizePhone(value: string): string {
  return value.replace(/\D+/g, "");
}

function normalizeTechnicianMap(
  map: Record<string, unknown>
): Record<string, TechnicianInfo> {
  const normalized: Record<string, TechnicianInfo> = {};
  for (const [name, value] of Object.entries(map)) {
    const nameText = String(name ?? "").trim();
    if (!nameText) {
      continue;
    }

    // Nuevo formato: [celular, glpi_id]
    if (Array.isArray(value) && value.length >= 2) {
      const phone = String(value[0] ?? "").trim();
      const glpiId = String(value[1] ?? "").trim();

      if (!phone || !glpiId) {
        continue;
      }

      const normalizedPhone = normalizePhone(phone);
      if (!normalizedPhone) {
        continue;
      }

      normalized[normalizedPhone] = {
        name: nameText,
        phone: normalizedPhone,
        glpiId,
      };
    }
    // Formato antiguo por compatibilidad (phone -> name/glpi_id)
    else {
      const valueText = String(value ?? "").trim();
      if (!valueText) {
        continue;
      }
      const phoneDigits = normalizePhone(nameText);
      const valueDigits = normalizePhone(valueText);

      if (phoneDigits.length >= 8) {
        normalized[phoneDigits] = {
          name: valueText,
          phone: phoneDigits,
          glpiId: valueText,
        };
      } else if (valueDigits.length >= 8) {
        normalized[valueDigits] = {
          name: nameText,
          phone: valueDigits,
          glpiId: nameText,
        };
      }
    }
  }
  return normalized;
}

export function loadConfig(): AppConfig {
  const groupName = (process.env.WHATSAPP_GROUP_NAME || "").trim();
  if (!groupName) {
    throw new Error("Falta WHATSAPP_GROUP_NAME en el archivo .env.");
  }

  const sessionDir =
    process.env.WHATSAPP_SESSION_DIR || path.join(process.cwd(), ".wa_session");
  const headless = envBool(process.env.WHATSAPP_HEADLESS, true);
  const executablePath =
    process.env.WHATSAPP_PUPPETEER_EXECUTABLE_PATH ||
    process.env.PUPPETEER_EXECUTABLE_PATH ||
    undefined;
  const clientId = (process.env.WHATSAPP_CLIENT_ID || "").trim() || undefined;

  const defaultCategoriesPath = path.join(process.cwd(), "categories.json");
  const envCategoriesPath =
    process.env.KNOWLEDGE_BASE_PATH || process.env.CATEGORIES_PATH || "";
  const categoriesPath =
    envCategoriesPath && fs.existsSync(envCategoriesPath)
      ? envCategoriesPath
      : defaultCategoriesPath;

  const glpiBaseUrl = normalizeGlpiBaseUrl(process.env.GLPI_BASE_URL);
  const glpiUser = (process.env.GLPI_USER || "").trim();
  const glpiPassword = (process.env.GLPI_PASSWORD || "").trim();
  const glpiDefaultRequester = (process.env.GLPI_DEFAULT_REQUESTER || "").trim();
  const glpiProfileId = (process.env.GLPI_PROFILE_ID || "").trim();
  const glpiProfileName = (process.env.GLPI_PROFILE_NAME || "OPERADOR").trim();
  const glpiSearchProfileId = (process.env.GLPI_SEARCH_PROFILE_ID || "").trim();
  const glpiSearchProfileName = (process.env.GLPI_SEARCH_PROFILE_NAME || "").trim();
  const dniFieldIds = (process.env.GLPI_DNI_FIELD_IDS || "")
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
  const glpiEnabled = Boolean(glpiBaseUrl && glpiUser && glpiPassword);

  const defaultCategoryIdRaw = Number(
    process.env.GLPI_DEFAULT_CATEGORY_ID || "1"
  );
  const defaultCategoryId = Number.isNaN(defaultCategoryIdRaw)
    ? 1
    : defaultCategoryIdRaw;

  let techniciansByPhone: Record<string, TechnicianInfo> = {};
  const techniciansRaw = (process.env.TECHNICIAN_BY_PHONE || "").trim();
  let techniciansPath = (process.env.TECHNICIAN_BY_PHONE_PATH || "").trim();
  const defaultNumbersMapPath = path.join(
    process.cwd(),
    "numbers-map.json"
  );
  if (!techniciansPath && !techniciansRaw && fs.existsSync(defaultNumbersMapPath)) {
    techniciansPath = defaultNumbersMapPath;
  }
  if (techniciansRaw) {
    try {
      const parsed = JSON.parse(techniciansRaw) as Record<string, unknown>;
      techniciansByPhone = normalizeTechnicianMap(parsed || {});
    } catch (err) {
      console.warn("TECHNICIAN_BY_PHONE no es un JSON valido.");
    }
  } else if (techniciansPath && fs.existsSync(techniciansPath)) {
    try {
      const raw = fs.readFileSync(techniciansPath, "utf-8");
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      techniciansByPhone = normalizeTechnicianMap(parsed || {});
    } catch (err) {
      console.warn("No se pudo leer TECHNICIAN_BY_PHONE_PATH.");
    }
  }

  return {
    whatsapp: {
      groupName,
      sessionDir,
      headless,
      executablePath,
      clientId,
    },
    glpi: {
      baseUrl: glpiBaseUrl,
      user: glpiUser,
      password: glpiPassword,
      defaultRequester: glpiDefaultRequester,
      dniFieldIds,
      profileId: glpiProfileId,
      profileName: glpiProfileName,
      searchProfileId: glpiSearchProfileId,
      searchProfileName: glpiSearchProfileName,
      enabled: glpiEnabled,
    },
    categoriesPath,
    defaultCategoryId,
    techniciansByPhone,
  };
}
