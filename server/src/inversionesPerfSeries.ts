/**
 * The home dashboard's «Δ mensual y depósitos por clase (inversiones)» combo, built on the
 * server at both grains so the client only picks.
 *
 * Monthly: one point per month of the inversiones consolidation (`buildInversionesConsolidatedMonthly`,
 * Σ of the retirement and brokerage bucket consolidations): `delta_combined` / `ytd_combined` /
 * `accumulated_earnings` are its `nominal_pl` / `ytd_nominal_pl` / `cumulative_nominal_pl`, the
 * two class bars each bucket's own consolidated `nominal_pl`, so the chart equals the Inversiones
 * «Detalle por mes» table by construction.
 *
 * Daily: the two buckets' own daily series (the `pg:` builds their group pages share) give the
 * day bars; the running levels are anchored on the monthly consolidation so the day-mode area
 * equals the monthly chart at the end of the window's first month (`dailyPerfLevels.ts`).
 */

import { monthKeyFromYmd } from "./calendarMonth.js";
import { dailyPerfLevelsFromMonthly } from "./dailyPerfLevels.js";
import type { BucketDailySeries } from "./dailySeries.js";
import { resolveGroupDailySeries } from "./groupDailySeries.js";
import {
  getGroupConsolidatedMonthlyPerfForRows,
  type ConsolidatedMonthlyPerfRow,
} from "./groupMonthlyPerfConsolidation.js";
import {
  buildInversionesConsolidatedMonthly,
  INVERSIONES_DASHBOARD_BUCKET_SLUGS,
} from "./netWorthConsolidation.js";
import { portfolioGroupSlugForDashboardBucket } from "./portfolioGroupValueAtDate.js";
import { listAccountsForGroupTab, type TsUnit } from "./valuationTimeseries.js";

export type InversionesPerfPoint = {
  as_of_date: string;
  /** Retirement / brokerage P/L of the period (each bucket's own consolidation or daily series). */
  delta_retirement: number;
  delta_brokerage: number;
  /** Σ Δ: the inversiones consolidation's `nominal_pl` (monthly) or the two day bars' sum (daily). */
  delta_combined: number;
  /** Running P/L of the calendar year through the period. */
  ytd_combined: number;
  /** Running P/L since the first month on record. */
  accumulated_earnings: number;
  /** Net personal deposits of the period by class, and their sum. */
  deposits_retirement: number;
  deposits_brokerage: number;
  deposits_inversiones: number;
};

export type InversionesPerfMonthly = { unit: TsUnit; points: InversionesPerfPoint[] };
export type InversionesPerfDaily = { unit: TsUnit; days: number; points: InversionesPerfPoint[] };

/** One deposits point of the month (`inversiones_deposits_chart.monthly_*`, month-end dated). */
export type InversionesDepositsMonth = { as_of_date: string; retirement: number; brokerage: number };

const finiteOr0 = (v: number | null | undefined): number =>
  v != null && Number.isFinite(v) ? v : 0;

/** A bucket's consolidated rows by the path `buildInversionesConsolidatedMonthly` sums (cached). */
function bucketConsolidatedByMonth(
  bucket: (typeof INVERSIONES_DASHBOARD_BUCKET_SLUGS)[number],
  unit: TsUnit
): Map<string, ConsolidatedMonthlyPerfRow> {
  const pgSlug = portfolioGroupSlugForDashboardBucket(bucket);
  const rows = listAccountsForGroupTab(pgSlug);
  const out = new Map<string, ConsolidatedMonthlyPerfRow>();
  if (!rows.length) return out;
  for (const row of getGroupConsolidatedMonthlyPerfForRows(rows, pgSlug, unit)) {
    out.set(monthKeyFromYmd(row.as_of_date), row);
  }
  return out;
}

/**
 * Monthly combo points (oldest first). `depositsMonthly` is the page payload's
 * `inversiones_deposits_chart` series in `unit`; a month with deposits and no P/L row is left
 * out, as the chart has always done.
 */
export function buildInversionesPerfMonthly(
  unit: TsUnit,
  depositsMonthly: readonly InversionesDepositsMonth[]
): InversionesPerfMonthly {
  const retirement = bucketConsolidatedByMonth("retirement", unit);
  const brokerage = bucketConsolidatedByMonth("brokerage", unit);
  const depositsByMonth = new Map<string, InversionesDepositsMonth>();
  for (const d of depositsMonthly) {
    const mk = monthKeyFromYmd(d.as_of_date);
    if (depositsByMonth.has(mk)) {
      throw new Error(`buildInversionesPerfMonthly: two deposits points for ${mk}`);
    }
    depositsByMonth.set(mk, d);
  }
  const points = [...buildInversionesConsolidatedMonthly(unit)].reverse().map((row) => {
    const mk = monthKeyFromYmd(row.as_of_date);
    const dep = depositsByMonth.get(mk);
    const depRet = dep?.retirement ?? 0;
    const depBrk = dep?.brokerage ?? 0;
    return {
      as_of_date: row.as_of_date,
      delta_retirement: finiteOr0(retirement.get(mk)?.nominal_pl),
      delta_brokerage: finiteOr0(brokerage.get(mk)?.nominal_pl),
      delta_combined: finiteOr0(row.nominal_pl),
      ytd_combined: finiteOr0(row.ytd_nominal_pl),
      accumulated_earnings: finiteOr0(row.cumulative_nominal_pl),
      deposits_retirement: depRet,
      deposits_brokerage: depBrk,
      deposits_inversiones: depRet + depBrk,
    };
  });
  return { unit, points };
}

/** Per-day personal deposits from the cumulative aportes total (the window's first day reads 0). */
function depositsPerDay(series: BucketDailySeries | null, length: number): number[] {
  const cum = series?.deposits_acum_total;
  if (!cum?.length) return new Array<number>(length).fill(0);
  return cum.map((v, i) => (i === 0 ? 0 : v - (cum[i - 1] ?? 0)));
}

/** @heavy Two bucket daily series (shared with the group pages' day view) + the monthly anchor. */
export function buildInversionesPerfDaily(unit: TsUnit, days: number): InversionesPerfDaily {
  const ret = resolveGroupDailySeries(portfolioGroupSlugForDashboardBucket("retirement"), unit, days);
  const brk = resolveGroupDailySeries(portfolioGroupSlugForDashboardBucket("brokerage"), unit, days);
  const grid = (ret ?? brk)?.points.map((p) => p.as_of_date) ?? [];
  for (const s of [ret, brk]) {
    if (!s) continue;
    const dates = s.points.map((p) => p.as_of_date);
    if (dates.length !== grid.length || dates.some((d, i) => d !== grid[i])) {
      throw new Error("buildInversionesPerfDaily: retirement and brokerage daily grids differ");
    }
  }
  const plOf = (s: BucketDailySeries | null, i: number): number => finiteOr0(s?.points[i]?.pl);
  const depRet = depositsPerDay(ret, grid.length);
  const depBrk = depositsPerDay(brk, grid.length);
  const deltas = grid.map((_, i) => plOf(ret, i) + plOf(brk, i));

  const monthlyAsc = [...buildInversionesConsolidatedMonthly(unit)].reverse();
  const levels = dailyPerfLevelsFromMonthly(grid, deltas, monthlyAsc);
  const points: InversionesPerfPoint[] = grid.map((d, i) => ({
    as_of_date: d,
    delta_retirement: plOf(ret, i),
    delta_brokerage: plOf(brk, i),
    delta_combined: deltas[i]!,
    ytd_combined: levels.ytd[i]!,
    accumulated_earnings: levels.accumulated[i]!,
    deposits_retirement: depRet[i]!,
    deposits_brokerage: depBrk[i]!,
    deposits_inversiones: depRet[i]! + depBrk[i]!,
  }));
  return { unit, days, points };
}
