import fs from "fs";

import type { CategoryEntry } from "./types";
import { normalizeTemplateKey } from "./text";

export function loadCategories(filePath: string): CategoryEntry[] {
  if (!fs.existsSync(filePath)) {
    return [];
  }
  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed.filter(
      (entry) => entry && typeof entry.category === "string"
    ) as CategoryEntry[];
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`No se pudo leer categories.json: ${message}`);
    return [];
  }
}

export function createCategoryIndex(
  entries: CategoryEntry[]
): Map<string, CategoryEntry> {
  return new Map(
    entries.map((entry) => [normalizeTemplateKey(entry.category), entry])
  );
}

export function getCategoryInfo(
  index: Map<string, CategoryEntry>,
  categoryName: string | undefined
): CategoryEntry | null {
  if (!categoryName) {
    return null;
  }
  const key = normalizeTemplateKey(categoryName);
  return index.get(key) || null;
}
