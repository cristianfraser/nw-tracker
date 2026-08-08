import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { BankName } from "./config.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Repo root (`nw-tracker/`), one level above `scraper/`. */
export function resolveRepoRoot(): string {
  return path.resolve(__dirname, "..", "..");
}

/** Personal-data root (`cfraser/`) — gitignored; everything the fetcher reads or writes lives here. */
export function resolveCfraserDir(): string {
  const env = process.env.CFRASER_CSV_DIR?.trim();
  if (env) return path.resolve(env);
  return path.join(resolveRepoRoot(), "cfraser");
}

/**
 * Drop zone consumed by `npm run import:cfraser-inbox`. Shared by both banks on purpose — the
 * organizer identifies documents by their filename, not by which fetcher produced them.
 */
export function resolveInboxDir(): string {
  const env = process.env.CFRASER_INBOX_DIR?.trim();
  if (env) return path.resolve(env);
  return path.join(resolveCfraserDir(), "inbox");
}

/** Raw API captures + screenshots from `--capture` runs, per bank. */
export function resolveCaptureDir(bank: BankName): string {
  return path.join(resolveCfraserDir(), `${bank}-captures`);
}

/** Movement JSON staged for the nw-tracker importer, per bank. */
export function resolveMovementsDir(bank: BankName): string {
  return path.join(resolveCfraserDir(), `${bank}-movements`);
}

/**
 * Structured statement JSON, saved next to — not instead of — the PDF. The PDF stays the source of
 * record until the two can be diffed on the same statement.
 */
export function resolveStatementJsonDir(bank: BankName): string {
  return path.join(resolveCfraserDir(), `${bank}-statement-json`);
}

/**
 * Chrome profile the fetcher drives, one per bank. Deliberately NOT the user's own profile: that one
 * is locked while Chrome runs, and a dedicated directory keeps each bank session isolated and
 * disposable. Persistence is what carries cookies and device trust between nightly runs — and for
 * Lider it is also what lets Cloudflare Turnstile recognise a returning browser.
 */
export function resolveBrowserProfileDir(bank: BankName): string {
  return path.join(resolveCfraserDir(), `.browser-profile-${bank}`);
}

export function ensureDir(dir: string): string {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
