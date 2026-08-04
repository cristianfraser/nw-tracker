/**
 * Native movement amounts (migration 169). A movement stores one `amount` in its own
 * `currency`; a cross-currency transfer additionally carries the to-leg as
 * `counter_amount`/`counter_currency` (compra_usd_venta_clp: amount = CLP from-leg,
 * counter = USD to-leg). There is no stored CLP equivalent for non-CLP movements —
 * same as the legacy pair, where a USD movement's `amount_clp` was 0.
 *
 * Reader guidance:
 *   - Aggregations over mixed account sets: `movementClpLegOrZero` / `movementUsdLeg`
 *     (exact legacy `amount_clp` / `amount_usd` semantics — 0 / null when absent).
 *   - CLP-only surfaces (checking, cartola, depto): `requireMovementClp` — a non-CLP
 *     row there is bad data; throw, don't coerce (equity_daily precedent).
 *   - In-query sums: interpolate `MOVEMENT_CLP_LEG_SQL` / `MOVEMENT_USD_LEG_SQL`.
 */

export const MOVEMENT_CURRENCIES = ["clp", "usd", "eur"] as const;
export type MovementCurrency = (typeof MOVEMENT_CURRENCIES)[number];

export function isMovementCurrency(value: unknown): value is MovementCurrency {
  return (MOVEMENT_CURRENCIES as readonly unknown[]).includes(value);
}

export function requireMovementCurrency(value: unknown, context?: string): MovementCurrency {
  if (!isMovementCurrency(value)) {
    throw new Error(`Invalid movement currency ${JSON.stringify(value)}${context ? ` (${context})` : ""}`);
  }
  return value;
}

/** The amount columns as stored on `movements` (currency widened for raw SQLite rows). */
export type MovementAmountFields = {
  amount: number;
  currency: string;
  counter_amount: number | null;
  counter_currency: string | null;
};

function legOf(row: MovementAmountFields, currency: MovementCurrency): number | null {
  if (row.currency === currency) return row.amount;
  if (row.counter_currency === currency) return row.counter_amount;
  return null;
}

/** The row's CLP leg, or 0 when it has none — exact legacy `amount_clp` semantics. */
export function movementClpLegOrZero(row: MovementAmountFields): number {
  return legOf(row, "clp") ?? 0;
}

/** The row's USD leg, or null when it has none — exact legacy `amount_usd` semantics. */
export function movementUsdLeg(row: MovementAmountFields): number | null {
  return legOf(row, "usd");
}

/**
 * CLP-only surfaces: the movement must be CLP-denominated (its primary leg — a
 * cross-currency transfer's CLP from-leg qualifies). Throws otherwise: on these
 * surfaces a non-CLP row is a data problem to fix, not a value to coerce.
 */
export function requireMovementClp(
  row: MovementAmountFields & { id?: number | null },
  context?: string
): number {
  if (row.currency === "clp") return row.amount;
  throw new Error(
    `Movement${row.id != null ? ` ${row.id}` : ""} is ${row.currency}-denominated on a CLP-only surface${
      context ? ` (${context})` : ""
    }`
  );
}

/** SQL column list for the amount fields, single sourced for movements SELECTs. */
export const MOVEMENT_AMOUNT_COLUMNS_SQL = "amount, currency, counter_amount, counter_currency";

/** In-query CLP leg (legacy `amount_clp` semantics). Movements table only. */
export const MOVEMENT_CLP_LEG_SQL =
  "(CASE WHEN currency = 'clp' THEN amount WHEN counter_currency = 'clp' THEN counter_amount ELSE 0 END)";

/** In-query USD leg (legacy `amount_usd` semantics: NULL when absent). Movements table only. */
export const MOVEMENT_USD_LEG_SQL =
  "(CASE WHEN currency = 'usd' THEN amount WHEN counter_currency = 'usd' THEN counter_amount END)";
