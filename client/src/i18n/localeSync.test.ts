import { describe, expect, it } from "vitest";
import en from "./locales/en.json";
import es from "./locales/es.json";
import master from "./master.json";

/**
 * master.json ↔ locales sync.
 *
 * master.json is the single source of truth: every leaf is { en, es }. The
 * committed locales/es.json and locales/en.json must be exactly what
 * `npm run i18n:generate` (client/scripts/i18n-generate.mjs) produces from it.
 * If this fails, someone edited a locale file (or master.json) without
 * regenerating — move copy edits to master.json and rerun the generator.
 *
 * The extraction logic is intentionally duplicated from i18n-generate.mjs
 * (a ~15-line walk); keep the two in sync if the master format ever changes.
 */

const LANGUAGES = ["en", "es"] as const;
type Language = (typeof LANGUAGES)[number];

type MasterNode = string | { [key: string]: MasterNode };

function isTranslationLeaf(node: MasterNode): node is Record<Language, string> {
  if (typeof node !== "object" || node === null) return false;
  const keys = Object.keys(node);
  return (
    keys.length === LANGUAGES.length &&
    LANGUAGES.every((lang) => typeof (node as Record<string, unknown>)[lang] === "string")
  );
}

function localeFromMaster(node: MasterNode, lang: Language, keyPath = ""): unknown {
  if (isTranslationLeaf(node)) return node[lang];
  if (typeof node !== "object" || node === null) {
    throw new Error(`master.json: "${keyPath}" must be a {en, es} leaf or a group of them`);
  }
  if (LANGUAGES.some((l) => l in node)) {
    throw new Error(`master.json: "${keyPath}" mixes language keys with group keys`);
  }
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(node)) {
    out[key] = localeFromMaster(child, lang, keyPath ? `${keyPath}.${key}` : key);
  }
  return out;
}

describe("master.json ↔ locale sync", () => {
  it("es.json matches what i18n:generate produces from master.json", () => {
    expect(es).toEqual(localeFromMaster(master as MasterNode, "es"));
  });

  it("en.json matches what i18n:generate produces from master.json", () => {
    expect(en).toEqual(localeFromMaster(master as MasterNode, "en"));
  });
});
