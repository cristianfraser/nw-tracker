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
type Ledger = Partial<Record<BankName, Record<string, string[]>>>;

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

export function hasDocument(bank: BankName, kind: string, key: string): boolean {
  if (forceRefetch) return false;
  return (readLedger()[bank]?.[kind] ?? []).includes(key);
}

export function recordDocument(bank: BankName, kind: string, key: string): void {
  const ledger = readLedger();
  const forBank = (ledger[bank] ??= {});
  const keys = (forBank[kind] ??= []);
  if (!keys.includes(key)) keys.push(key);
  fs.writeFileSync(ledgerFile(), JSON.stringify(ledger, null, 2));
}

/**
 * The most recent closed calendar month, in Chile — the cartola that should exist today.
 *
 * On 2026-08-05 that is `2026-07`; on 2026-09-01 it becomes `2026-08`, which is what makes the
 * fetcher start asking for the August cartola daily until the bank publishes it.
 */
export function lastClosedMonth(now: Date = new Date()): string {
  const chile = new Date(now.toLocaleString("en-US", { timeZone: "America/Santiago" }));
  const year = chile.getFullYear();
  const month = chile.getMonth(); // 0-based; month-1 in 1-based terms is exactly this value
  const target = month === 0 ? { y: year - 1, m: 12 } : { y: year, m: month };
  return `${target.y}-${String(target.m).padStart(2, "0")}`;
}
