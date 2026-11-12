import { serverConfig } from "./config.js";

/** The live dollar's pair key: an fx row's symbol is its pair, `<BASE>_<QUOTE>` (migration 323). */
export const LIVE_FX_SYMBOL = "USD_CLP";

/** `fx`: a live exchange rate, its symbol the pair key and its value quote units per base unit. */
export type LiveMarketQuoteKind = "equity" | "fx";

/** The live-quote settings, read from the server config (`config.ts`: `LIVE_QUOTES_*`). */

export function liveQuotesSyncEnabled(): boolean {
  return serverConfig().liveQuotes.enabled;
}

export function liveQuotesIntervalMs(): number {
  return serverConfig().liveQuotes.intervalMs;
}

/**
 * Poll cadence while a market the poll prices is in its regular session and the price stream is
 * not connected (default 2 min; with the stream up the poll keeps the base cadence). Each
 * poll that moves a price rebuilds the dashboard caches (~10–20 s of work on the real DB), so
 * a one-minute cadence would keep the server busy for a third of every minute.
 */
export function liveQuotesSessionIntervalMs(): number {
  return serverConfig().liveQuotes.sessionIntervalMs;
}

export function liveQuotesRetentionHours(): number {
  return serverConfig().liveQuotes.retentionHours;
}

/** Max age for HTTP paths to treat a stored quote as live (default 2× poll interval). */
export function liveQuotesMaxAgeMs(): number {
  return serverConfig().liveQuotes.maxAgeMs;
}

/**
 * Yahoo's price stream (`yahooPriceStream.ts`): live prices as they trade, with the REST poll as
 * the backstop. `LIVE_QUOTES_STREAM_ENABLED=0` falls back to polling alone.
 */
export function liveQuotesStreamEnabled(): boolean {
  return serverConfig().liveQuotes.streamEnabled;
}

export function liveQuotesStreamUrl(): string {
  return serverConfig().liveQuotes.streamUrl;
}

/**
 * Least time between two stream writes that move a price (default 5 s): each one rebuilds the
 * dashboard caches. The hosted demo's small instance sets more (`render.yaml`).
 */
export function liveQuotesFlushGapMs(): number {
  return serverConfig().liveQuotes.flushGapMs;
}
