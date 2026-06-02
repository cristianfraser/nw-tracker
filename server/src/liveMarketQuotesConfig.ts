import { loadRootDotenv } from "./rootDotenv.js";

export const LIVE_FX_SYMBOL = "USD_CLP";

export type LiveMarketQuoteKind = "equity_usd" | "fx_clp_per_usd";

function envFlag(name: string, defaultOn: boolean): boolean {
  loadRootDotenv();
  const v = process.env[name]?.trim().toLowerCase();
  if (v === "0" || v === "false" || v === "no") return false;
  if (v === "1" || v === "true" || v === "yes") return true;
  return defaultOn;
}

function envMs(name: string, fallback: number): number {
  loadRootDotenv();
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function envHours(name: string, fallback: number): number {
  loadRootDotenv();
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function liveQuotesSyncEnabled(): boolean {
  return envFlag("LIVE_QUOTES_SYNC_ENABLED", true);
}

export function liveQuotesIntervalMs(): number {
  return envMs("LIVE_QUOTES_INTERVAL_MS", 5 * 60 * 1000);
}

export function liveQuotesRetentionHours(): number {
  return envHours("LIVE_QUOTES_RETENTION_HOURS", 48);
}

/** Max age for HTTP paths to treat a stored quote as live (default 2× poll interval). */
export function liveQuotesMaxAgeMs(): number {
  const explicit = envMs("LIVE_QUOTES_MAX_AGE_MS", 0);
  if (explicit > 0) return explicit;
  return liveQuotesIntervalMs() * 2;
}
