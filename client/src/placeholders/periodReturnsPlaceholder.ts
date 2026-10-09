import type { PeriodReturnKey, PeriodReturnsPayload } from "../types";

/** The server's fixed window order (mirrors `types/performance.ts`). */
export const PERIOD_RETURN_KEYS: readonly PeriodReturnKey[] = [
  "d1",
  "w1",
  "mtd",
  "ytd",
  "y1",
  "y3",
  "y5",
  "total",
];

/**
 * The Rentabilidad table's frame before its payload is in: every window in the server's order,
 * every cell empty (null % and amount render «—»). Nothing is invented — it only gives the table
 * its columns while it loads.
 */
export function placeholderPeriodReturnsPayload(unit: PeriodReturnsPayload["unit"]): PeriodReturnsPayload {
  return {
    unit,
    as_of_date: "",
    first_month: "",
    periods: PERIOD_RETURN_KEYS.map((period) => ({
      period,
      pct: null,
      nominal_pl: null,
      annualized_pct: null,
      months: 0,
      window_start_month: null,
      window_start_date: null,
    })),
  };
}
