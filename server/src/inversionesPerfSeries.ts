/**
 * The home dashboard's «Δ mensual por clase (inversiones)» combo, built on the
 * server so the client only picks (monthly and yearly only; there is no day mode).
 *
 * Monthly: one point per month of the inversiones consolidation (`buildInversionesConsolidatedMonthly`,
 * Σ of the retirement and brokerage bucket consolidations): `delta_combined` / `ytd_combined` /
 * `accumulated_earnings` are its `nominal_pl` / `ytd_nominal_pl` / `cumulative_nominal_pl`, the
 * two class bars each bucket's own consolidated `nominal_pl`, so the chart equals the Inversiones
 * «Detalle por mes» table by construction.
 *
 * The % view (2026-11-05): every point also carries the period's return of each class and of
 * Inversiones, its YTD and its all-time return, all the scope's daily returns compounded
 * (`periodPctDailyChain.ts`, the rule every % surface reads) — so a month equals its «Detalle
 * por mes» row, the YTD point the Rentabilidad YTD and the last all-time point its TOTAL. The
 * monthly block adds `yearly_pct`, one point per calendar year, since a year's % is a compound
 * the client must not rebuild from the months.
 */

import { monthKeyFromYmd } from "./calendarMonth.js";
import { chainDailyPct, withDailyChainedMonthPct, type DailyPctPoint } from "./periodPctDailyChain.js";
import { groupDailyPctPoints } from "./dailyPctSeries.js";
import {
  getGroupConsolidatedMonthlyPerfForRows,
  type ConsolidatedMonthlyPerfRow,
} from "./groupMonthlyPerfConsolidation.js";
import { buildInversionesConsolidatedMonthly } from "./netWorthConsolidation.js";
import { listAccountsForGroupTab, type TsUnit } from "./valuationTimeseries.js";

export type InversionesPerfPoint = {
  as_of_date: string;
  /** Retirement / brokerage P/L of the period (each bucket's own consolidation). */
  delta_retirement: number;
  delta_brokerage: number;
  /** Σ Δ: the inversiones consolidation's `nominal_pl`. */
  delta_combined: number;
  /** Running P/L of the calendar year through the period. */
  ytd_combined: number;
  /** Running P/L since the first month on record. */
  accumulated_earnings: number;
} & InversionesPerfPct;

/** The % view of a point: compounded daily returns (fractions; null = nothing held in it). */
export type InversionesPerfPct = {
  /** Each class's own return over the period (they do not add up, so they are not stacked). */
  pct_retirement: number | null;
  pct_brokerage: number | null;
  /** Inversiones' return over the period. */
  pct_combined: number | null;
  /** Inversiones' return from the previous year-end through the point. */
  ytd_pct: number | null;
  /** Inversiones' return since its first day through the point. */
  accumulated_pct: number | null;
};

/** One calendar year of the % view, dated on its last monthly point (today for the current year). */
export type InversionesPerfYearPct = { as_of_date: string } & InversionesPerfPct;

export type InversionesPerfMonthly = {
  unit: TsUnit;
  points: InversionesPerfPoint[];
  yearly_pct: InversionesPerfYearPct[];
};

/** The full-history daily returns of retirement, brokerage and Inversiones (shared `pg:` builds). */
function classDailyPoints(unit: TsUnit): {
  retirement: readonly DailyPctPoint[];
  brokerage: readonly DailyPctPoint[];
  combined: readonly DailyPctPoint[];
} {
  const pointsOf = (slug: string) => groupDailyPctPoints(slug, unit) ?? [];
  return {
    retirement: pointsOf("retirement"),
    brokerage: pointsOf("brokerage"),
    combined: pointsOf("inversiones"),
  };
}

const priorYearEndYmd = (ymd: string): string => `${Number(ymd.slice(0, 4)) - 1}-12-31`;

const finiteOr0 = (v: number | null | undefined): number =>
  v != null && Number.isFinite(v) ? v : 0;

/** A bucket's consolidated rows by the path `buildInversionesConsolidatedMonthly` sums (cached). */
function bucketConsolidatedByMonth(
  bucket: "retirement" | "brokerage",
  unit: TsUnit
): Map<string, ConsolidatedMonthlyPerfRow> {
  const pgSlug = bucket;
  const rows = listAccountsForGroupTab(pgSlug);
  const out = new Map<string, ConsolidatedMonthlyPerfRow>();
  if (!rows.length) return out;
  for (const row of getGroupConsolidatedMonthlyPerfForRows(rows, pgSlug, unit)) {
    out.set(monthKeyFromYmd(row.as_of_date), row);
  }
  return out;
}

/** Monthly combo points (oldest first), one per month of the inversiones consolidation. */
export function buildInversionesPerfMonthly(unit: TsUnit): InversionesPerfMonthly {
  const retirement = bucketConsolidatedByMonth("retirement", unit);
  const brokerage = bucketConsolidatedByMonth("brokerage", unit);
  const daily = classDailyPoints(unit);
  const monthRows = [...buildInversionesConsolidatedMonthly(unit)].reverse();
  const monthPct = (pts: readonly DailyPctPoint[]) =>
    withDailyChainedMonthPct(
      monthRows.map((r) => ({ as_of_date: r.as_of_date, pct_month: null })),
      pts
    ).map((r) => r.pct_month);
  const pctRet = monthPct(daily.retirement);
  const pctBrk = monthPct(daily.brokerage);
  const pctComb = monthPct(daily.combined);
  const points = monthRows.map((row, i) => {
    const mk = monthKeyFromYmd(row.as_of_date);
    return {
      as_of_date: row.as_of_date,
      delta_retirement: finiteOr0(retirement.get(mk)?.nominal_pl),
      delta_brokerage: finiteOr0(brokerage.get(mk)?.nominal_pl),
      delta_combined: finiteOr0(row.nominal_pl),
      ytd_combined: finiteOr0(row.ytd_nominal_pl),
      accumulated_earnings: finiteOr0(row.cumulative_nominal_pl),
      pct_retirement: pctRet[i]!,
      pct_brokerage: pctBrk[i]!,
      pct_combined: pctComb[i]!,
      ytd_pct: chainDailyPct(daily.combined, priorYearEndYmd(row.as_of_date), row.as_of_date),
      accumulated_pct: chainDailyPct(daily.combined, null, row.as_of_date),
    };
  });
  const lastOfYear = new Map<string, string>();
  for (const p of points) lastOfYear.set(p.as_of_date.slice(0, 4), p.as_of_date);
  const yearly_pct: InversionesPerfYearPct[] = [...lastOfYear.values()].map((d) => {
    const start = priorYearEndYmd(d);
    const year = chainDailyPct(daily.combined, start, d);
    return {
      as_of_date: d,
      pct_retirement: chainDailyPct(daily.retirement, start, d),
      pct_brokerage: chainDailyPct(daily.brokerage, start, d),
      pct_combined: year,
      ytd_pct: year,
      accumulated_pct: chainDailyPct(daily.combined, null, d),
    };
  });
  return { unit, points, yearly_pct };
}
