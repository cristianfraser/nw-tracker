import fs from "node:fs";
import path from "node:path";
import { ensureDir, resolveCfraserDir } from "./paths.js";
import type { BankName } from "./config.js";

/**
 * Which periodic documents have already been fetched.
 *
 * Monthly documents are worth exactly one download each. Without this the fetcher would re-request
 * the same cartola every night — pointless traffic against a bank that is already sensitive to it,
 * and it can't be answered by looking at the inbox, because `import:cfraser-inbox` moves files out
 * to their archive directories as soon as they are imported.
 *
 * The intended rhythm: a period becomes due the day after it closes, is retried once a day until
 * the bank actually publishes it, and is never asked for again afterwards.
 */
/**
 * Ledger namespaces: the web-session banks plus e-mail-only sources. Lider has no web
 * session any more (its statement and boletas arrive by mail), but its documents keep
 * their own namespace so the keys never collide with a bank's.
 */
export type DocumentSource = BankName | "lider" | "fintual";

type Ledger = Partial<Record<DocumentSource, Record<string, string[]>>>;

function ledgerFile(): string {
  return path.join(ensureDir(resolveCfraserDir()), ".scraper-documents.json");
}

function readLedger(): Ledger {
  const file = ledgerFile();
  if (!fs.existsSync(file)) return {};
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as Ledger;
  } catch {
    // A corrupt ledger costs one redundant download, not a lost document — start clean.
    return {};
  }
}

/**
 * When set, `hasDocument` reports nothing as fetched.
 *
 * Set once per run from `--force`, so re-fetching a document you already have is a deliberate act
 * rather than something the ledger silently prevents while you are testing.
 */
let forceRefetch = false;

export function setForceRefetch(force: boolean): void {
  forceRefetch = force;
}

export function hasDocument(bank: DocumentSource, kind: string, key: string): boolean {
  if (forceRefetch) return false;
  return (readLedger()[bank]?.[kind] ?? []).includes(key);
}

export function recordDocument(bank: DocumentSource, kind: string, key: string): void {
  const ledger = readLedger();
  const forBank = (ledger[bank] ??= {});
  const keys = (forBank[kind] ??= []);
  if (!keys.includes(key)) keys.push(key);
  fs.writeFileSync(ledgerFile(), JSON.stringify(ledger, null, 2));
}

