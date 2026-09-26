import { rangeWindowStartYmd } from "./chartRangeWindow";
import type { TimeRange } from "./timeRange";
import type { CcFacturadoBarSegments, CcHistorialChartPoint, DailySeriesResponse } from "./types";

const NO_BAR: CcFacturadoBarSegments = {
  facturado_cuotas_clp: null,
  facturado_rest_clp: null,
  facturado_usd_clp: null,
  facturado_usd: null,
  facturado_total_clp: null,
};

function nextDayYmd(ymd: string): string {
  return new Date(Date.parse(`${ymd}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
}

/**
 * Day-period rows of the CC historial chart from a daily-series payload carrying the server's
 * CC block (`cc_owed` / `cc_installment_debt` / `cc_plan_tail` / `cc_facturacion_bars` — a card's
 * own page or a Pasivos / credit-card group page, requested in CLP). The historical days map
 * straight onto the two lines (saldo total = owed walk, deuda en cuotas = plan debt), the plan
 * tail extends the grid past today to the plan end, and each facturación bar lands on its close
 * day — the grid runs on, lines empty, to a close past its end (an open month closing after the
 * plan tail). The leading empty grid is clipped to the shared range window (20 % empty lead as
 * the truncation cue; `total` starts flush at the first data day). Null when the payload carries
 * no CC block — the caller distinguishes "not fetched yet" from "not a CC scope" itself.
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
    ...NO_BAR,
    cupo_en_cuotas_clp: debt?.[i] ?? null,
    balance_total_clp: owed[i] ?? null,
  }));
  for (const tail of daily.cc_plan_tail ?? []) {
    rows.push({
      month: tail.as_of_date,
      ...NO_BAR,
      cupo_en_cuotas_clp: tail.plan_debt_clp,
      balance_total_clp: tail.balance_clp,
    });
  }
  const bars = daily.cc_facturacion_bars ?? [];
  const lastBar = bars.at(-1)?.as_of_date ?? null;
  for (let d = rows.at(-1)!.month; lastBar != null && d < lastBar; ) {
    d = nextDayYmd(d);
    rows.push({ month: d, ...NO_BAR, cupo_en_cuotas_clp: null, balance_total_clp: null });
  }
  const rowIndexByDay = new Map(rows.map((r, i) => [r.month, i] as const));
  for (const { as_of_date, ...bar } of bars) {
    // The grid is every day from the series' first (where the server clips the bars) onward.
    const i = rowIndexByDay.get(as_of_date);
    if (i == null) throw new Error(`CC historial: billing bar ${as_of_date} is off the daily grid`);
    rows[i] = { ...rows[i]!, ...bar };
  }
  const firstData =
    rows.find((r) => r.cupo_en_cuotas_clp != null || r.balance_total_clp != null)?.month ?? null;
  const start = rangeWindowStartYmd(timeRange, firstData, todayYmd);
  return start == null ? rows : rows.filter((r) => r.month >= start);
}
