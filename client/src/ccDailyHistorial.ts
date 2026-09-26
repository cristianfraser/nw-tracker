import { rangeWindowStartYmd } from "./chartRangeWindow";
import type { TimeRange } from "./timeRange";
import type { CcHistorialChartPoint, DailySeriesResponse } from "./types";

/**
 * Day-period rows of the CC historial chart from a daily-series payload carrying the server's
 * CC block (`cc_owed` / `cc_installment_debt` / `cc_plan_tail` — a card's own page or a
 * Pasivos / credit-card group page, requested in CLP). The historical days map straight onto
 * the two lines (saldo total = owed walk, deuda en cuotas = plan debt; the month-frame bars
 * stay null), the plan tail extends the grid past today to the plan end, and the leading
 * empty grid is clipped to the shared range window (20 % empty lead as the truncation cue;
 * `total` starts flush at the first data day). Null when the payload carries no CC block —
 * the caller distinguishes "not fetched yet" from "not a CC scope" itself.
 */
export function buildCcDailyHistorialRows(
  daily: DailySeriesResponse,
  timeRange: TimeRange,
  todayYmd?: string
): CcHistorialChartPoint[] | null {
  const owed = daily.cc_owed;
  if (!owed || !daily.points.length) return null;
  const debt = daily.cc_installment_debt ?? null;
  const rows: CcHistorialChartPoint[] = daily.points.map((pt, i) => ({
    month: pt.as_of_date,
    installment_payments_clp: 0,
    facturado_clp: null,
    cupo_en_cuotas_clp: debt?.[i] ?? null,
    balance_total_clp: owed[i] ?? null,
  }));
  for (const tail of daily.cc_plan_tail ?? []) {
    rows.push({
      month: tail.as_of_date,
      installment_payments_clp: 0,
      facturado_clp: null,
      cupo_en_cuotas_clp: tail.plan_debt_clp,
      balance_total_clp: tail.balance_clp,
    });
  }
  const firstData =
    rows.find((r) => r.cupo_en_cuotas_clp != null || r.balance_total_clp != null)?.month ?? null;
  const start = rangeWindowStartYmd(timeRange, firstData, todayYmd);
  return start == null ? rows : rows.filter((r) => r.month >= start);
}
