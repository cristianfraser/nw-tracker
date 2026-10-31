/**
 * Loads the user's own vendor-catalog entries (people, RUTs, places — personal data) from an
 * untracked file into `vendor_catalog` as `source = 'user'`, replacing every user row: the file is
 * the whole list. Report-first: without --apply it prints what would change and writes nothing.
 *
 *   npx tsx scripts/load-vendor-catalog.ts [--file=../cfraser/vendor-catalog.json] [--apply]   (from server/)
 *
 * File: { "entries": [ { "kind": "exact" | "prefix" | "branch" | "rut", "pattern": "…", "display": "…" } ] }
 * Patterns are written as printed; they are folded here (upper case, no accents, single spaces),
 * a RUT reduced to digits + verifier. See `vendorCatalog.ts`.
 */
import fs from "node:fs";
import path from "node:path";
import { db } from "../src/db.js";
import { foldVendorName, normalizeRut, type VendorCatalogKind } from "../src/vendorCatalog.js";

const KINDS: readonly VendorCatalogKind[] = ["exact", "prefix", "branch", "rut"];
const arg = (name: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? null;
const apply = process.argv.includes("--apply");
const file = path.resolve(arg("file") ?? path.join(import.meta.dirname, "../../cfraser/vendor-catalog.json"));

const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as { entries?: unknown };
if (!Array.isArray(parsed.entries)) throw new Error(`${file}: expected { "entries": [...] }`);

type Entry = { kind: VendorCatalogKind; pattern: string; display: string };
const wanted = new Map<string, Entry>();
for (const [i, e] of (parsed.entries as Record<string, unknown>[]).entries()) {
  const kind = e.kind as VendorCatalogKind;
  if (!KINDS.includes(kind)) throw new Error(`entry ${i}: kind must be one of ${KINDS.join(", ")}`);
  if (typeof e.pattern !== "string" || typeof e.display !== "string" || !e.pattern.trim() || !e.display.trim()) {
    throw new Error(`entry ${i}: pattern and display must be non-empty strings`);
  }
  const pattern = kind === "rut" ? normalizeRut(e.pattern) : foldVendorName(e.pattern);
  if (kind === "rut" && !/^\d{6,9}[0-9K]$/.test(pattern)) throw new Error(`entry ${i}: «${e.pattern}» is not a RUT`);
  const key = `${kind}|${pattern}`;
  const prev = wanted.get(key);
  if (prev && prev.display !== e.display.trim()) {
    throw new Error(`entry ${i}: ${kind} «${pattern}» listed twice with different names («${prev.display}», «${e.display}»)`);
  }
  wanted.set(key, { kind, pattern, display: e.display.trim() });
}

const current = new Map(
  (db.prepare(`SELECT match_kind AS kind, pattern, display FROM vendor_catalog WHERE source = 'user'`).all() as Entry[]).map((e) => [
    `${e.kind}|${e.pattern}`,
    e,
  ])
);

const added = [...wanted].filter(([k]) => !current.has(k)).map(([, e]) => e);
const removed = [...current].filter(([k]) => !wanted.has(k)).map(([, e]) => e);
const changed = [...wanted].filter(([k, e]) => current.has(k) && current.get(k)!.display !== e.display).map(([k, e]) => ({ from: current.get(k)!, to: e }));

console.log(`${file}: ${wanted.size} entries (${current.size} user entries stored)`);
for (const e of added) console.log(`  + ${e.kind.padEnd(6)} ${e.pattern} → ${e.display}`);
for (const c of changed) console.log(`  ~ ${c.to.kind.padEnd(6)} ${c.to.pattern} → ${c.to.display} (was ${c.from.display})`);
for (const e of removed) console.log(`  - ${e.kind.padEnd(6)} ${e.pattern} → ${e.display}`);
if (added.length + changed.length + removed.length === 0) console.log("  nothing to change");

if (!apply) {
  console.log("\nReport only; run with --apply to write.");
} else {
  db.transaction(() => {
    db.prepare(`DELETE FROM vendor_catalog WHERE source = 'user'`).run();
    const ins = db.prepare(`INSERT INTO vendor_catalog (match_kind, pattern, display, source) VALUES (?, ?, ?, 'user')`);
    for (const e of wanted.values()) ins.run(e.kind, e.pattern, e.display);
  }).immediate();
  console.log(`\nWrote ${wanted.size} user entries.`);
}
