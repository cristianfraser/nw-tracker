import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import es from "./locales/es.json";

/**
 * es.json ↔ source integrity.
 *
 * - "missing": a key referenced via `t("…")` / `i18n.t("…")` / `i18nKey="…"` that es.json does
 *   not define — i18next would render the raw key string.
 * - "dead": a defined key that no string literal in client/src mentions and that no dynamic
 *   template prefix (`` t(`family.${x}`) ``) can reach. Keys built by string concatenation would
 *   be false positives here — the codebase uses template literals or literal Records instead,
 *   so keep it that way (or reference the key in a comment-visible literal).
 */

const SRC_ROOT = fileURLToPath(new URL("..", import.meta.url));

function listSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listSourceFiles(full));
    else if (/\.(ts|tsx)$/.test(entry.name)) out.push(full);
  }
  return out;
}

function flattenKeys(obj: Record<string, unknown>, prefix = ""): string[] {
  const keys: string[] = [];
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === "object") keys.push(...flattenKeys(v as Record<string, unknown>, key));
    else keys.push(key);
  }
  return keys;
}

const KEY_LITERAL_RE = /"([a-zA-Z0-9_.]+)"|'([a-zA-Z0-9_.]+)'|`([a-zA-Z0-9_.]+)`/g;
const DYNAMIC_PREFIX_RE = /`([a-zA-Z0-9_.]+\.)\$\{/g;
const T_CALL_RE = /(?:^|[^A-Za-z0-9_])t\(\s*["'`]([a-zA-Z0-9_.]+)["'`]/g;
const I18NKEY_RE = /i18nKey=["']([a-zA-Z0-9_.]+)["']/g;

describe("es.json key integrity", () => {
  const defined = new Set(flattenKeys(es as unknown as Record<string, unknown>));

  const literals = new Set<string>();
  const dynamicPrefixes = new Set<string>();
  const referenced = new Set<string>();
  for (const file of listSourceFiles(SRC_ROOT)) {
    const text = fs.readFileSync(file, "utf8");
    for (const m of text.matchAll(KEY_LITERAL_RE)) {
      literals.add((m[1] ?? m[2] ?? m[3])!);
    }
    for (const m of text.matchAll(DYNAMIC_PREFIX_RE)) dynamicPrefixes.add(m[1]!);
    for (const m of text.matchAll(T_CALL_RE)) referenced.add(m[1]!);
    for (const m of text.matchAll(I18NKEY_RE)) referenced.add(m[1]!);
  }

  it("every t()/i18nKey reference resolves to a defined key", () => {
    const missing = [...referenced]
      .filter((k) => k.includes(".") && !defined.has(k))
      // Dynamic families resolve at runtime; a literal that *is* a full key of such a family
      // is covered by the dead-key check instead.
      .filter((k) => ![...dynamicPrefixes].some((p) => k.startsWith(p)))
      .sort();
    expect(missing).toEqual([]);
  });

  it("every defined key is reachable from source (no dead keys)", () => {
    const dead = [...defined]
      .filter((k) => !literals.has(k))
      .filter((k) => ![...dynamicPrefixes].some((p) => k.startsWith(p)))
      .sort();
    expect(dead).toEqual([]);
  });
});
