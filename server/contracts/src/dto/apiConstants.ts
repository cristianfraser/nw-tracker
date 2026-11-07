/** Values the server and the client must agree on outside a payload (docs/untangle-plan.md F8). */

/** The usage log's page-view beacon: a POST, and the one mutation the read-only demo accepts. */
export const USAGE_PAGE_VIEW_PATH = "/api/usage/page-view";

/**
 * The live-quotes poll's default interval (server `LIVE_QUOTES_INTERVAL_MS`); the client refetches
 * the live dashboard queries on the same period, so account marks refresh after each tick.
 */
export const LIVE_QUOTES_DEFAULT_INTERVAL_MS = 5 * 60_000;
