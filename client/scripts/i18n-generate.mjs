/**
 * Locale generator: client/src/i18n/master.json → locales/es.json + locales/en.json.
 *
 * master.json is the single source of truth for UI copy. It mirrors the locale
 * files' nesting, but every leaf holds all languages side by side:
 *
 *   { "common": { "save": { "en": "Save", "es": "Guardar" } } }
 *
 * The tree is nested (not flat dotted keys) because some leaf keys contain
 * literal dots (e.g. panelAccounts.addAccount."accountType.equity"), which a
 * flat format could not reconstruct unambiguously.
 *
 * Edit master.json, then run `npm run i18n:generate -w nw-tracker-client`.
 * Never edit locales/es.json / locales/en.json by hand — the
 * src/i18n/localeSync.test.ts guard fails if they drift from master.json.
 *
 * Fail fast: a leaf must define exactly the LANGUAGES below, all strings —
 * anything else (missing language, extra key, non-string) throws.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const I18N_DIR = fileURLToPath(new URL("../src/i18n", import.meta.url));
const MASTER_PATH = path.join(I18N_DIR, "master.json");
const LANGUAGES = ["en", "es"];

/** A leaf is an object whose keys are exactly LANGUAGES with string values. */
export function isTranslationLeaf(node) {
  if (node === null || typeof node !== "object" || Array.isArray(node)) return false;
  const keys = Object.keys(node);
  return (
    keys.length === LANGUAGES.length &&
    LANGUAGES.every((lang) => typeof node[lang] === "string")
  );
}

/** Extract one language's nested tree from the master tree. Throws on malformed nodes. */
export function localeFromMaster(node, lang, keyPath = "") {
  if (isTranslationLeaf(node)) return node[lang];
  if (node === null || typeof node !== "object" || Array.isArray(node)) {
    throw new Error(
      `master.json: "${keyPath}" must be a translation leaf {${LANGUAGES.join(", ")}} or a group of them`
    );
  }
  if (LANGUAGES.some((lang2) => lang2 in node)) {
    throw new Error(
      `master.json: "${keyPath}" mixes language keys with group keys — a leaf needs exactly {${LANGUAGES.join(", ")}} as strings`
    );
  }
  const out = {};
  for (const [key, child] of Object.entries(node)) {
    out[key] = localeFromMaster(child, lang, keyPath ? `${keyPath}.${key}` : key);
  }
  return out;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const master = JSON.parse(fs.readFileSync(MASTER_PATH, "utf8"));
  for (const lang of LANGUAGES) {
    const outPath = path.join(I18N_DIR, "locales", `${lang}.json`);
    fs.writeFileSync(outPath, `${JSON.stringify(localeFromMaster(master, lang), null, 2)}\n`);
    console.log(`i18n-generate: wrote ${path.relative(process.cwd(), outPath)}`);
  }
}
