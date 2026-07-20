import {
  loadMergedDisplayDepositInflowEvents,
  type DepositInflowEvent,
} from "./accountDeposits.js";
import { getAggregationCached } from "./aggregationCache.js";
import { cashInterestClpThroughDate, cashInterestUsdThroughDate } from "./cashAccountInterest.js";
import { depositInflowEventUsd } from "./flowsDeposits.js";
import { nyseSessionsListEndingAt } from "./marketHolidays.js";
import { isUsdCashAccount } from "./movementTransfer.js";
import { isNyseRegularSessionOpen, nyseDisplaySessionYmd } from "./nyseSession.js";
import {
  bucketValueInUnitAt,
  includeShortHorizonAccount,
  type ShortHorizonAccountRef,
} from "./periodReturnsShortHorizon.js";
import { usdCashBalanceClpAt, usdCashBalanceUsdAt } from "./usdCashAccounts.js";
import { convertTs, type TsUnit } from "./valuationTimeseries.js";

/**
 * Daily bucket series on the NYSE session grid — the "vs last workday" view. One point per
 * session ending at `nyseDisplaySessionYmd` (the live session when open, else the last
 * completed one), so a Monday point's delta covers everything since Friday's close (weekend
 * crypto/UF drift included), matching the Rentabilidad strip's d1 cell and the watchlist
 * `day_pct` convention.
 *
 * Value legs are the same per-account marks the d1 cell uses (`bucketValueInUnitAt` →
 * `accountMarkClpAtYmd`: MTM EOD, cuotas × valor cuota, cartola balance, UF marks, stored
 * valuations on-or-before; live stack when the session is Chile today). Flows use the same
 * deposit-event accounting as `netDepositFlowBetween`, bucketed per session window
 * `(prev_session, session]`. `pl = delta − flow`; a missing leg yields nulls, never a fake 0.
 *
 * Accounts whose marks only move monthly (stored month-end valuations) render honestly as
 * steps: flat rows, the whole month's delta on the mark day, and `−flow` on a deposit day
 * until the next mark absorbs it.
 */

const RETURN_EPS = 1e-9;

/** Hard cap on the session window (~19 months of trading days). */
export const DAILY_SERIES_MAX_SESSIONS = 400;

export type DailySeriesPoint = {
  as_of_date: string;
  /** Bucket value at session close (live for the open session), in the request unit. */
  value: number | null;
  /** Net deposit flow in `(prev_session, session]`, in the request unit. */
  flow: number;
  /** Total balance change vs the prior session (`value − prev`); null when a leg is missing. */
  delta: number | null;
  /** Flow-adjusted P/L (`delta − flow`); null when `delta` is. */
  pl: number | null;
  /** `pl / (prev + flow)`; null when `pl` is null or the denominator is ~0. */
  pct: number | null;
};

export type BucketDailySeries = {
  unit: TsUnit;
  /** Last grid session = the NYSE display session at build time. */
  end_session_ymd: string;
  /** True while the NYSE regular session is open (the last point tracks live marks). */
  d1_is_live: boolean;
  /** Prior-session anchor for the first point (its `delta` baseline). */
  baseline: { as_of_date: string; value: number | null };
  points: DailySeriesPoint[];
};

/**
 * Per-session net deposit flows for one grid. Same event source and window semantics as
 * `netDepositFlowBetween` — regular accounts bucket merged display deposit events into
 * `(sessions[i-1], sessions[i]]`; USD-cash accounts telescope `balance − interest` at each
 * session (identical sums by construction, one evaluation per session instead of per pair).
 * Returns CLP flows for clp/uf units and native USD flows for usd (events without USD skip,
 * as in `netDepositFlowBetween`).
 */
function sessionFlows(
  accounts: readonly ShortHorizonAccountRef[],
  sessions: readonly string[],
  flowUnit: "clp" | "usd"
): number[] {
  const flows = new Array<number>(sessions.length - 1).fill(0);
  const first = sessions[0]!;
  const last = sessions[sessions.length - 1]!;

  const regularIds: number[] = [];
  const usdCashIds: number[] = [];
  for (const a of accounts) {
    if (!includeShortHorizonAccount(a)) continue;
    (isUsdCashAccount(a.account_id) ? usdCashIds : regularIds).push(a.account_id);
  }

  const eventsById = loadMergedDisplayDepositInflowEvents(regularIds);
  const rowIndexForEvent = (occurredOn: string): number => {
    // First i ≥ 1 with sessions[i] ≥ occurredOn → row i − 1 (window (sessions[i−1], sessions[i]]).
    let lo = 1;
    let hi = sessions.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (sessions[mid]! >= occurredOn) hi = mid;
      else lo = mid + 1;
    }
    return lo - 1;
  };
  for (const id of regularIds) {
    for (const e of eventsById.get(id) ?? []) {
      if (e.amt === 0 || !Number.isFinite(e.amt)) continue;
      if (e.occurred_on <= first || e.occurred_on > last) continue;
      const amt = flowUnit === "usd" ? usdFlowForEvent(e) : e.amt;
      if (amt == null) continue;
      flows[rowIndexForEvent(e.occurred_on)] += amt;
    }
  }

  for (const id of usdCashIds) {
    const depAt =
      flowUnit === "usd"
        ? (ymd: string) => usdCashBalanceUsdAt(id, ymd) - cashInterestUsdThroughDate(id, ymd)
        : (ymd: string) => usdCashBalanceClpAt(id, ymd) - cashInterestClpThroughDate(id, ymd);
    let prev = depAt(first);
    for (let i = 1; i < sessions.length; i++) {
      const cur = depAt(sessions[i]!);
      flows[i - 1] += cur - prev;
      prev = cur;
    }
  }

  return flows;
}

function usdFlowForEvent(e: DepositInflowEvent): number | null {
  const usd = depositInflowEventUsd(e);
  return usd != null && Number.isFinite(usd) ? usd : null;
}

export type BucketDailySeriesOpts = {
  unit: TsUnit;
  /** Number of daily points (sessions) to emit, 1..{@link DAILY_SERIES_MAX_SESSIONS}. */
  sessions: number;
  now?: Date;
};

/** Build the daily series for one bucket of accounts. Throws on an out-of-bounds window. */
export function getBucketDailySeries(
  accounts: readonly ShortHorizonAccountRef[],
  opts: BucketDailySeriesOpts
): BucketDailySeries {
  const { unit, sessions: count } = opts;
  if (!Number.isInteger(count) || count < 1 || count > DAILY_SERIES_MAX_SESSIONS) {
    throw new Error(`getBucketDailySeries: sessions must be 1..${DAILY_SERIES_MAX_SESSIONS}, got ${count}`);
  }
  const now = opts.now ?? new Date();
  const endSession = nyseDisplaySessionYmd(now);
  // count + 1 sessions: [0] is the baseline anchor for the first point's delta.
  const grid = nyseSessionsListEndingAt(endSession, count + 1);

  const values = grid.map((ymd) => bucketValueInUnitAt(accounts, ymd, unit, now));
  const flowUnit = unit === "usd" ? "usd" : "clp";
  const flows = sessionFlows(accounts, grid, flowUnit);

  const points: DailySeriesPoint[] = [];
  for (let i = 1; i < grid.length; i++) {
    const ymd = grid[i]!;
    const raw = flows[i - 1]!;
    const flow = unit === "uf" ? convertTs(raw, ymd, "uf") : raw;
    const value = values[i]!;
    const prev = values[i - 1]!;
    const delta = value != null && prev != null ? value - prev : null;
    const pl = delta != null ? delta - flow : null;
    const denom = prev != null ? prev + flow : null;
    const pct =
      pl != null && denom != null && Math.abs(denom) > RETURN_EPS && Number.isFinite(pl / denom)
        ? pl / denom
        : null;
    points.push({ as_of_date: ymd, value, flow, delta, pl, pct });
  }

  return {
    unit,
    end_session_ymd: endSession,
    d1_is_live: isNyseRegularSessionOpen(now),
    baseline: { as_of_date: grid[0]!, value: values[0]! },
    points,
  };
}

/**
 * Aggregation-cached build (always the real clock — an explicit `now` would poison entries).
 * `scopeKey` names the bucket (portfolio group slug, `account:<id>`, …); the account-id
 * fingerprint guards membership changes within a scope. Entries drop on any account/CC write
 * or market-data tick (`invalidateDailySeries` in `aggregationCache.ts`) and at day rollover.
 */
export function getBucketDailySeriesCached(
  scopeKey: string,
  accounts: readonly ShortHorizonAccountRef[],
  opts: { unit: TsUnit; sessions: number }
): BucketDailySeries {
  const rowsKey = accounts.map((a) => a.account_id).join(",");
  const key = `daily.series|${scopeKey}|${opts.unit}|${opts.sessions}|${rowsKey}`;
  return getAggregationCached(key, () => getBucketDailySeries(accounts, opts));
}
