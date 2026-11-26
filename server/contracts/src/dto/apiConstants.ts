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

/**
 * The account kinds (the leaf kind an account's `category_slug` states) whose page is the checking
 * page: the cartola checking kinds and the cash ledger leaves. The client mounts the page from it
 * before the detail bundle is in; the server's own rule is the account profile
 * (`isCheckingPageAccount`, `checkingStatement.ts`), and a server test holds the two together.
 */
export const CHECKING_PAGE_KIND_SLUGS: readonly string[] = [
  "cuenta_corriente",
  "cuenta_vista",
  "clp",
  "usd",
  "foreign_cash",
  "buda_clp",
];

/** The age /projections retires at (server `projections.ts`). */
export const PROJECTION_RETIRE_AGE = 65;

/**
 * The bounds of every /projections input: the server refuses a request outside them
 * (`projectionParamsFromQuery`) and the form sends only values inside them, so both read this.
 */
export const PROJECTION_NUMBER_PARAM_BOUNDS = {
  real_return_pct: [-5, 20],
  retire_return_pct: [-5, 20],
  end_age: [PROJECTION_RETIRE_AGE + 1, 110],
  swr_pct: [0, 25],
  pct_balance_pct: [0, 25],
  liquidate_other_pct: [0, 100],
} as const satisfies Record<string, readonly [number, number]>;

/** Bounds of the money inputs (monthly contribution, fixed income, passive rent), in the currency typed. */
export const PROJECTION_MONEY_BOUNDS: readonly [number, number] = [0, 1_000_000_000];

/** Bounds of every `inflation_<code>_pct` input. */
export const PROJECTION_INFLATION_BOUNDS: readonly [number, number] = [0, 30];
