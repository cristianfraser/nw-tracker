import { loadRootDotenv } from "./rootDotenv.js";

export const LIVE_FX_SYMBOL = "USD_CLP";

export type LiveMarketQuoteKind = "equity" | "fx_clp_per_usd";

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

/**
 * Poll cadence while a market the poll prices is in its regular session and the price stream is
 * not connected (default 2 min; with the stream up the poll keeps the base cadence). Each
 * poll that moves a price rebuilds the dashboard caches (~10–20 s of work on the real DB), so
 * a one-minute cadence would keep the server busy for a third of every minute.
 */
export function liveQuotesSessionIntervalMs(): number {
  return envMs("LIVE_QUOTES_SESSION_INTERVAL_MS", 2 * 60 * 1000);
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

/**
 * Yahoo's price stream (`yahooPriceStream.ts`): live prices as they trade, with the REST poll as
 * the backstop. `LIVE_QUOTES_STREAM_ENABLED=0` falls back to polling alone.
 */
export function liveQuotesStreamEnabled(): boolean {
  return envFlag("LIVE_QUOTES_STREAM_ENABLED", true);
}

export function liveQuotesStreamUrl(): string {
  loadRootDotenv();
  return process.env.LIVE_QUOTES_STREAM_URL?.trim() || "wss://streamer.finance.yahoo.com/?version=2";
}

/**
 * Least time between two stream writes that move a price (default 5 s): each one rebuilds the
 * dashboard caches. The hosted demo's small instance sets more (`render.yaml`).
 */
export function liveQuotesFlushGapMs(): number {
  return envMs("LIVE_QUOTES_FLUSH_GAP_MS", 5_000);
}
