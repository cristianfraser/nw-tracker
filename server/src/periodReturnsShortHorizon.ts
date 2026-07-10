import { accountMarkClpAtYmd } from "./accountMarkClpAtYmd.js";
import { chileCalendarAddDays, chileCalendarTodayYmd } from "./chileDate.js";
import { netDepositFlowBetween } from "./flowsDeposits.js";
import { fxForLiveMtm } from "./fxRates.js";
import { nyseSessionsBack, priorNyseSessionYmd } from "./marketHolidays.js";
import { isNyseRegularSessionOpen, nyseDisplaySessionYmd } from "./nyseSession.js";
import type { PeriodReturnCell, PeriodReturnsPayload } from "./periodReturns.js";
import { convertTs, type TsUnit } from "./valuationTimeseries.js";

/**
 * Short-horizon (1D / 1W) returns for the Rentabilidad strip. Unlike the monthly windows
 * (chained `pct_month`), these are reconstructed from daily marks: value the bucket on two
 * anchor dates by summing `accountMarkClpAtYmd`, flow-adjust with the same deposit-event
 * accounting the monthly builder uses, and express in the request unit.
 *
 * Anchoring matches the watchlist composite `day_pct` (`compositeLiveStats`): the END leg is
 * the NYSE display session — the live session when open, else the last completed one — so a
 * weekend view reads "last full day" (Fri close vs Thu close) with every mixed-calendar
 * constituent (NYSE / `.SN` / crypto / cuota / cash) resolving its own on-or-before close at
 * one shared anchor date. Fail-fast: an unavailable leg yields a null cell, never a fake 0%.
 */

const RETURN_EPS = 1e-9;

export type ShortHorizonAccountRef = {
  account_id: number;
  name?: string | null;
  bucket_slug: string;
  import_key?: string | null;
  exclude_from_group_totals?: number;
};

function includeAccount(a: ShortHorizonAccountRef): boolean {
  return a.account_id > 0 && a.exclude_from_group_totals !== 1;
}

/**
 * Convert a CLP leg to `unit`. For a USD view of the live-today leg, use the same intraday
 * `CLP=X` the live mark was built with (`fxForLiveMtm`) — `convertTs` would divide by EOD FX
 * and leave an FX artifact in the USD return on the live day. Prior/historical legs use
 * `convertTs` (EOD on-or-before), which cancels each mark's own EOD FX cleanly.
 */
function convertLegToUnit(rawClp: number, ymd: string, unit: TsUnit, now: Date): number {
  if (unit === "usd" && ymd === chileCalendarTodayYmd()) {
    const live = fxForLiveMtm(ymd, now);
    if (live != null && Number.isFinite(live.clp_per_usd) && live.clp_per_usd > 0) {
      return rawClp / live.clp_per_usd;
    }
  }
  return convertTs(rawClp, ymd, unit);
}

/** Sum per-account CLP marks at `ymd`, converted once to `unit`; null when no account marks. */
function bucketValueInUnitAt(
  accounts: readonly ShortHorizonAccountRef[],
  ymd: string,
  unit: TsUnit,
  now: Date
): number | null {
  let rawClp = 0;
  let any = false;
  for (const a of accounts) {
    if (!includeAccount(a)) continue;
    const mark = accountMarkClpAtYmd(a.account_id, ymd, a.bucket_slug, {
      import_key: a.import_key ?? null,
      name: a.name ?? null,
    });
    if (mark?.value_clp != null && Number.isFinite(mark.value_clp)) {
      rawClp += mark.value_clp;
      any = true;
    }
  }
  if (!any) return null;
  return convertLegToUnit(rawClp, ymd, unit, now);
}

function emptyCell(
  period: PeriodReturnCell["period"],
  windowStartDate: string | null
): PeriodReturnCell {
  return {
    period,
    pct: null,
    nominal_pl: null,
    annualized_pct: null,
    months: 0,
    window_start_month: null,
    window_start_date: windowStartDate,
  };
}

/**
 * Pure flow-adjusted cell from the two value legs and the window flow (all in the display
 * unit). Return = `(V_end − V_start − flow) / (V_start + flow)`; null leg or ~0 denominator
 * → null pct (fail-fast, never a fabricated 0%).
 */
export function shortHorizonCellFromLegs(
  period: PeriodReturnCell["period"],
  vEnd: number | null,
  vStart: number | null,
  flow: number,
  startYmd: string | null
): PeriodReturnCell {
  if (vEnd == null || vStart == null || !Number.isFinite(vEnd) || !Number.isFinite(vStart)) {
    return emptyCell(period, startYmd);
  }
  const nominal = vEnd - vStart - flow;
  const denom = vStart + flow;
  const pct =
    Math.abs(denom) > RETURN_EPS && Number.isFinite(nominal / denom) ? nominal / denom : null;
  return {
    period,
    pct,
    nominal_pl: Number.isFinite(nominal) ? nominal : null,
    annualized_pct: null,
    months: 0,
    window_start_month: null,
    window_start_date: startYmd,
  };
}

function shortHorizonCell(
  period: PeriodReturnCell["period"],
  accounts: readonly ShortHorizonAccountRef[],
  unit: TsUnit,
  startYmd: string,
  endYmd: string,
  now: Date
): PeriodReturnCell {
  const vEnd = bucketValueInUnitAt(accounts, endYmd, unit, now);
  const vStart = bucketValueInUnitAt(accounts, startYmd, unit, now);
  if (vEnd == null || vStart == null) return emptyCell(period, startYmd);

  const flowUnit = unit === "usd" ? "usd" : "clp";
  let flowRaw = 0;
  for (const a of accounts) {
    if (!includeAccount(a)) continue;
    flowRaw += netDepositFlowBetween(a.account_id, startYmd, endYmd, flowUnit);
  }
  const flow = unit === "uf" ? convertTs(flowRaw, endYmd, "uf") : flowRaw;

  return shortHorizonCellFromLegs(period, vEnd, vStart, flow, startYmd);
}

/** The 1D and 1W cells plus whether the reference NYSE session is currently open. */
export function computeShortHorizonReturnCells(
  accounts: readonly ShortHorizonAccountRef[],
  unit: TsUnit,
  now: Date = new Date()
): { cells: PeriodReturnCell[]; d1_is_live: boolean } {
  const sessionYmd = nyseDisplaySessionYmd(now);
  const d1Start = priorNyseSessionYmd(sessionYmd);
  const w1Start = nyseSessionsBack(sessionYmd, 5) ?? chileCalendarAddDays(sessionYmd, -7);

  const d1 = d1Start ? shortHorizonCell("d1", accounts, unit, d1Start, sessionYmd, now) : emptyCell("d1", null);
  const w1 = w1Start ? shortHorizonCell("w1", accounts, unit, w1Start, sessionYmd, now) : emptyCell("w1", null);

  return { cells: [d1, w1], d1_is_live: isNyseRegularSessionOpen(now) };
}

/** Prepend the 1D/1W cells to a monthly period-returns payload (null passes through). */
export function withShortHorizonCells(
  payload: PeriodReturnsPayload | null,
  accounts: readonly ShortHorizonAccountRef[],
  unit: TsUnit,
  now: Date = new Date()
): PeriodReturnsPayload | null {
  if (payload == null) return null;
  const { cells, d1_is_live } = computeShortHorizonReturnCells(accounts, unit, now);
  return { ...payload, d1_is_live, periods: [...cells, ...payload.periods] };
}
