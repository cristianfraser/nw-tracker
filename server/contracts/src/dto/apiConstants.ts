/** Values the server and the client must agree on outside a payload (docs/untangle-plan.md F8). */

/** The usage log's page-view beacon: a POST, and the one mutation the read-only demo accepts. */
export const USAGE_PAGE_VIEW_PATH = "/api/usage/page-view";

/**
 * The live-quotes poll's default interval (server `LIVE_QUOTES_INTERVAL_MS`); the client refetches
 * the live dashboard queries on the same period, so account marks refresh after each tick.
 */
export const LIVE_QUOTES_DEFAULT_INTERVAL_MS = 5 * 60_000;

/**
 * The ledger's home currency, pesos: checking, the peso cash ledgers and the card's billing frame
 * are kept in it, and a request that names no `unit` is answered in it. Every other currency is
 * foreign cash (server `cashCurrency.ts`).
 */
export const HOME_CURRENCY = "clp";

/** `code` is the home currency (pesos). */
export function isHomeCurrency(code: string): boolean {
  return code === HOME_CURRENCY;
}
