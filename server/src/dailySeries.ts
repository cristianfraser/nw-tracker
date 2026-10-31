import { loadMergedDisplayDepositInflowEvents } from "./accountDeposits.js";
import { isLiabilityAccountId } from "./accountBucket.js";
import { buildHistoryTierValue, getAggregationCached, historyTierMemo } from "./aggregationCache.js";
import { isCreditCardAccountId } from "./ccAccountConfig.js";
import { ccFinancingCostClpByDate } from "./ccFinancingCostDaily.js";
import { chileCalendarAddDays, chileCalendarTodayYmd, chileWallClockAt } from "./chileDate.js";
import { loadDeptoLedgerFromMovements } from "./deptoLedgerFromMovements.js";
import { mortgageSheetPaymentEventsThroughDate } from "./deptoDividendosLedger.js";
import { flowEventInUnit } from "./flowsDeposits.js";
import { isChileBusinessDay, isNyseTradingDay } from "./marketHolidays.js";
import { accountMarkClpSeriesOnGrid } from "./accountMarkDailyCache.js";
import type { ChartBucketPlan } from "./groupChartBuckets.js";
import {
  includeShortHorizonAccount,
  type ShortHorizonAccountRef,
} from "./periodReturnsShortHorizon.js";
import { accountTodayValue } from "./accountTodayValue.js";
import { clpToUnitAt, pastDayUnitConverter } from "./clpToUnitAt.js";
import { isUsdCashAccount, usdCashBalanceUsdAt } from "./usdCashAccounts.js";
import { endChargedFlow, flowAdjustedPct, groupStartFrameFlow } from "./periodReturns.js";
import { portfolioStartYmd } from "./portfolioStart.js";
import { trailingZeroRunClipStartIndex } from "./timeseriesTailClip.js";
import { dbInTransaction } from "./db.js";
import { convertTs, type TsUnit } from "./valuationTimeseries.js";

/**
 * Daily bucket series on the **calendar-day** grid: one point per Chile calendar day ending
 * at today (live marks), weekends and holidays included. Each account attributes P/L on its
 * OWN market calendar automatically, because historical marks forward-fill on-or-before: a
 * USD stock is flat Sat/Sun (its full Fri→Mon move lands on Monday's row), a `.SN` stock or
 * AFP is flat on Chilean holidays, while crypto / UF assets / CC owed move every day — so
 * weekend rows carry exactly the every-day assets' P/L.
 *
 * Value legs are the same per-account marks the short-horizon cells use
 * (`accountMarkClpAtYmd`: MTM EOD, cuotas × valor cuota, cartola balance, UF marks, per-day
 * CC owed, stored valuations on-or-before; live stack for today). Flows use the same
 * deposit-event accounting as `netDepositFlowBetween`, bucketed per `(prev day, day]`.
 * `pl = delta − flow`; a missing leg yields nulls, never a fake 0.
 *
 * **Liability accounts** (mortgage, credit card) mark as positive debt, so their P/L is the
 * loss-negative `prior − owed − flow` of the dashboard day cells — a UF uptick or a card's
 * intereses read as the losses they are. Their flows are the money put INTO the debt (mortgage
 * cuotas, card payments; borrowing negative), which cancels the balance move and leaves
 * financing cost alone. Equivalently, and how it is computed below: P/L runs on **wealth**
 * (assets − liabilities), while `value` keeps showing the bucket as displayed.
 *
 * Accounts whose marks only move monthly (stored month-end valuations) render honestly as
 * steps — the book-value carry keeps deposit days at pl 0 and the mark day carries the
 * inter-mark P/L.
 */

/** Sanity bound on the day window (~20 years) — parameter validation, not a product cap. */
export const DAILY_SERIES_MAX_DAYS = 7400;

export type DailySeriesPoint = {
  as_of_date: string;
  /** Bucket value at that day's close (live for today), in the request unit. */
  value: number | null;
  /** Net capital flow in `(prev day, day]`, in the request unit (into a liability = positive). */
  flow: number;
  /** Total balance change vs the prior day (`value − prev`); null when a leg is missing. */
  delta: number | null;
  /** Flow-adjusted P/L; `delta − flow` for assets, `−delta − flow` for debt. Null when `delta` is. */
  pl: number | null;
  /**
   * `pl` over the capital at work by the shared rule (`flowAdjustedPct`): capital base + flow,
   * or the base alone when the day ends at zero or a withdrawal exceeds it; null when `pl` is
   * null or no positive capital base exists.
   */
  pct: number | null;
  /** False on weekends/shared holidays (no NYSE session AND no Chilean business day) — the
   * detalle table dims those rows; every-day assets still attribute real P/L on them. */
  market_day: boolean;
};

export type DailySeriesAccountLine = {
  account_id: number;
  name: string | null;
  /** Per-session values in the request unit, index-aligned with `points`. */
  values: (number | null)[];
  /** Cumulative personal deposits (full history through each session) — the aportes acum. line.
   * Null past the value line's trailing clip: a sold-out account's aportes end with its value,
   * as the monthly block clip bundles them. */
  deposits_acum?: (number | null)[];
  /**
   * Per-session flow-adjusted P/L for this account alone (the day-grain twin of the monthly
   * `pl_<account_id>` bars). Same convention as the bucket's `pl` — computed on wealth, so a
   * card's intereses and a UF uptick on the mortgage read as losses — and Σ over the accounts
   * equals the bucket's `pl` by construction.
   */
  pl?: (number | null)[];
};

export type BucketDailySeries = {
  unit: TsUnit;
  /** Last grid day = Chile today (the live point). */
  end_ymd: string;
  /** Prior-session anchor for the first point (its `delta` baseline). */
  baseline: { as_of_date: string; value: number | null };
  points: DailySeriesPoint[];
  /** Per-account value lines (chart series), present when `includeAccounts` was requested. */
  accounts?: DailySeriesAccountLine[];
  /** Σ of account `deposits_acum` per session (`__group_dep_total` line), same presence. */
  deposits_acum_total?: number[];
  /**
   * Internal (stripped from HTTP payloads): per-account PRE-TRIM cumulative deposits in the
   * request unit, index-aligned with `points`, for every included account — never-held and
   * wound-down members too. `groupDailySeriesAccounts` sums bucket aportes from these, never
   * from the display-trimmed `deposits_acum` lines: a trimmed member's terminal deposits must
   * not vanish from an active bucket's aggregate (same rule as `deposits_acum_total`, which
   * is the whole-group sum of exactly these arrays).
   */
  deposit_cums_raw?: Map<number, number[]>;
  /** Agrupado lines (bucket sums keyed by the monthly grouped block's synthetic ids). */
  grouped_accounts?: DailySeriesAccountLine[];
  /** "Sin agrupar" bucket lines (one nav level deeper; only when they differ from grouped). */
  ungrouped_accounts?: DailySeriesAccountLine[];
  /**
   * Mirror of the monthly block's `chart_end_ymd`: set when every account line ends before
   * the grid does (all sold out / wound down), so the valuation chart's x-axis stops at the
   * last visible day instead of the unclipped Total hugging 0 through today. `points` stay
   * full-length (the P/L bars and daily detalle table keep full history); the client
   * valuation-chart builder trims by this field.
   */
  chart_end_ymd?: string;
};

/** The last grid built (every scope of one rebuild asks for the same full-history grid). */
let lastDaysList: { endYmd: string; count: number; days: string[] } | null = null;

/** Ascending list of `count` Chile calendar days ending at `endYmd` inclusive. */
export function chileCalendarDaysListEndingAt(endYmd: string, count: number): string[] {
  if (lastDaysList?.endYmd === endYmd && lastDaysList.count === count) return lastDaysList.days.slice();
  const out = new Array<string>(count);
  for (let i = 0; i < count; i++) {
    out[count - 1 - i] = i === 0 ? endYmd : chileCalendarAddDays(endYmd, -i);
  }
  lastDaysList = { endYmd, count, days: out.slice() };
  return out;
}

/**
 * Per-day net capital flows for one grid. Same event source and window semantics as
 * `netDepositFlowBetween` — merged display deposit events bucketed into `(grid[i-1], grid[i]]`
 * (USD-cash accounts included since 2026-08-04, via `loadUsdCashCapitalSortFlows`). Returns
 * CLP flows for clp/uf units and USD flows for usd, every event at its own date's rate
 * (`flowEventInUnit`, as in `netDepositFlowBetween`).
 *
 * Liability accounts have no movement-based deposit events (the mortgage's cash is the depto
 * ledger, a card's is its statements), so they carry their own sources — positive when money
 * goes into the debt. `liabilityFlows` returns them separately because the P/L identity
 * subtracts them from a *falling* balance.
 */
/**
 * Grid days a member's money was in the bucket without a value: a run of days with no mark that
 * money entered (a flow inside the run) and that ends in a mark later on — e.g. an AFP whose first
 * contributions predate its first valuation. The bucket sums only the members that have a mark,
 * so on those days it would count the money in and not its value (−79% on the day it arrived,
 * +358% on the day the value appeared). Flags the run and the day the mark appears; the caller
 * gives those days no return. A member that was never valued (not yet open) or is no longer
 * valued (closed, the run never ends) is not flagged. `flows[g − 1]` is grid day g's flow, as
 * `gridFlows` builds it. Pure; exported for tests.
 */
export function unvaluedMemberDays(
  marks: readonly (number | null)[],
  flows: readonly number[] | undefined
): boolean[] {
  const out = new Array<boolean>(marks.length).fill(false);
  const has = (g: number) => marks[g] != null && Number.isFinite(marks[g]!);
  let g = 0;
  while (g < marks.length) {
    if (has(g)) {
      g += 1;
      continue;
    }
    const start = g;
    while (g < marks.length && !has(g)) g += 1;
    const end = g - 1; // last unmarked day of the run
    if (g >= marks.length) break; // never valued again
    let moneyIn = false;
    for (let d = Math.max(start, 1); d <= end; d++) {
      if ((flows?.[d - 1] ?? 0) !== 0) moneyIn = true;
    }
    if (!moneyIn) continue;
    for (let d = start; d <= end + 1; d++) out[d] = true;
  }
  return out;
}

function gridFlows(
  accounts: readonly ShortHorizonAccountRef[],
  sessions: readonly string[],
  flowUnit: "clp" | "usd"
): { flows: number[]; liabilityFlows: number[]; byAccount: Map<number, number[]> } {
  const flows = new Array<number>(sessions.length - 1).fill(0);
  const liabilityFlows = new Array<number>(sessions.length - 1).fill(0);
  // Same legs, kept per account so a per-account P/L line can be derived (Σ = the bucket legs).
  const byAccount = new Map<number, number[]>();
  const addFor = (accountId: number, row: number, amt: number): void => {
    let arr = byAccount.get(accountId);
    if (!arr) {
      arr = new Array<number>(sessions.length - 1).fill(0);
      byAccount.set(accountId, arr);
    }
    arr[row] += amt;
  };
  const first = sessions[0]!;
  const last = sessions[sessions.length - 1]!;

  const regularIds: number[] = [];
  const mortgageIds: number[] = [];
  for (const a of accounts) {
    if (!includeShortHorizonAccount(a)) continue;
    // Cards are handled by the caller (their flows need the value legs); other liabilities
    // (mortgage) carry ledger-truth payment events. USD-cash accounts are regular since
    // 2026-08-04 — their merged events come from loadUsdCashCapitalSortFlows.
    if (isCreditCardAccountId(a.account_id)) continue;
    if (isLiabilityAccountId(a.account_id)) mortgageIds.push(a.account_id);
    else regularIds.push(a.account_id);
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
      if (e.amt === 0) continue;
      if (e.occurred_on <= first || e.occurred_on > last) continue;
      const amt = flowEventInUnit(e, flowUnit);
      const row = rowIndexForEvent(e.occurred_on);
      flows[row] += amt;
      addFor(id, row, amt);
    }
  }

  // Mortgage cuotas/prepagos: ledger truth, positive (capital into the debt) — the depto
  // ledger is the mortgage's payment history, the same source the dashboard cards use. Cards
  // have no cash ledger; their flows are derived from the balance in `ccDerivedFlowsClp`.
  if (mortgageIds.length > 0) {
    for (const e of mortgageSheetPaymentEventsThroughDate(loadDeptoLedgerFromMovements(), last)) {
      if (e.pago_clp === 0) continue;
      if (e.occurred_on <= first || e.occurred_on > last) continue;
      const amt = flowEventInUnit({ occurred_on: e.occurred_on, amt: e.pago_clp }, flowUnit);
      const row = rowIndexForEvent(e.occurred_on);
      liabilityFlows[row] += amt;
      // The depto ledger is one mortgage's payment history (the loop above is gated on there
      // being any mortgage account), so attribute it to that account.
      addFor(mortgageIds[0]!, row, amt);
    }
  }

  return { flows, liabilityFlows, byAccount };
}

/**
 * Card flows per grid row, derived from its own daily owed marks: `−Δowed + financing`, so the
 * card's P/L comes out as exactly `−financing` (see `ccFinancingCostDaily.ts` for why the
 * balance move — anchor reframing included — is flow rather than cost). CLP; the caller
 * converts. Rows where either mark is missing carry no flow, never a fake 0.
 */
function ccDerivedFlowsClp(
  accountId: number,
  grid: readonly string[],
  marksClp: readonly (number | null)[]
): number[] {
  const financingByDate = ccFinancingCostClpByDate(accountId);
  const out = new Array<number>(grid.length - 1).fill(0);
  for (let i = 1; i < grid.length; i++) {
    const cur = marksClp[i];
    const prev = marksClp[i - 1];
    if (cur == null || prev == null) continue;
    out[i - 1] = -(cur - prev) + (financingByDate.get(grid[i]!) ?? 0);
  }
  return out;
}

/**
 * Full-history cumulative personal deposits through each grid date, per account — the
 * "aportes acum." chart companion. Same event source as {@link sessionFlows} (merged display
 * deposit events — USD-cash included since 2026-08-04), so the line's step on a deposit day
 * equals that day's flow leg. CLP for clp/uf units, USD for usd — each event at its own date's
 * rate, `flowEventInUnit` (uf conversion happens at emit time, per session date).
 */
function accountDepositCumsOnGrid(
  accounts: readonly ShortHorizonAccountRef[],
  grid: readonly string[],
  flowUnit: "clp" | "usd"
): Map<number, number[]> {
  const out = new Map<number, number[]>();
  const eventsById = loadMergedDisplayDepositInflowEvents(accounts.map((a) => a.account_id));

  for (const a of accounts) {
    const id = a.account_id;
    const events = eventsById.get(id) ?? [];
    const cums = new Array<number>(grid.length).fill(0);
    let cum = 0;
    let ei = 0;
    for (let gi = 0; gi < grid.length; gi++) {
      const ymd = grid[gi]!;
      while (ei < events.length && events[ei]!.occurred_on <= ymd) {
        const e = events[ei]!;
        ei += 1;
        if (e.amt === 0) continue;
        cum += flowEventInUnit(e, flowUnit);
      }
      cums[gi] = cum;
    }
    out.set(id, cums);
  }
  return out;
}

export type BucketDailySeriesOpts = {
  unit: TsUnit;
  /**
   * Number of daily points (calendar days) to emit, 1..{@link DAILY_SERIES_MAX_DAYS};
   * `0` = since portfolio start ("total").
   */
  days: number;
  now?: Date;
  /** Emit per-account value lines alongside the bucket points (same marks, no extra cost). */
  includeAccounts?: boolean;
};

/** Days in the "total" range: portfolio start through Chile today, inclusive of both ends. */
export function totalRangeDays(todayYmd: string = chileCalendarTodayYmd()): number {
  const start = portfolioStartYmd();
  const startMs = Date.parse(`${start}T00:00:00Z`);
  const endMs = Date.parse(`${todayYmd}T00:00:00Z`);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs < startMs) return 1;
  return Math.round((endMs - startMs) / 86_400_000) + 1;
}

/**
 * The part of a daily series that reads only evidence: each account's value in the unit on every
 * grid day but the last (null where it has no mark or no rate), the flow legs and deposit
 * cumulatives over the whole grid (ledger rows and stored rates; a write drops them), and each
 * grid day's market flag.
 */
type DailySeriesPast = {
  unitByAccount: (number | null)[][];
  flows: ReturnType<typeof gridFlows>;
  depositCums: Map<number, number[]> | null;
  marketDay: boolean[];
};

function dailySeriesPastKey(
  accounts: readonly ShortHorizonAccountRef[],
  unit: TsUnit,
  grid: readonly string[],
  withAccounts: boolean
): string {
  const ids = accounts
    .map((a) => `${a.account_id}:${a.bucket_slug}:${a.import_key ?? ""}:${a.exclude_from_group_totals ?? ""}`)
    .join(",");
  return `${unit}|${withAccounts ? 1 : 0}|${grid[0]}|${grid.length}|${ids}`;
}

function buildDailySeriesPast(
  accounts: readonly ShortHorizonAccountRef[],
  included: readonly ShortHorizonAccountRef[],
  grid: readonly string[],
  flowUnit: "clp" | "usd",
  marksByAccount: readonly (readonly (number | null)[])[],
  valueInUnit: (ai: number, clp: number, gi: number) => number | null,
  withAccounts: boolean
): DailySeriesPast {
  const lastGi = grid.length - 1;
  const unitByAccount = included.map((_a, ai) => {
    const out = new Array<number | null>(lastGi).fill(null);
    for (let gi = 0; gi < lastGi; gi++) {
      const clp = marksByAccount[ai]![gi];
      if (clp == null || !Number.isFinite(clp)) continue;
      const u = valueInUnit(ai, clp, gi);
      if (u != null && Number.isFinite(u)) out[gi] = u;
    }
    return out;
  });
  return {
    unitByAccount,
    flows: gridFlows(accounts, grid, flowUnit),
    depositCums: withAccounts ? accountDepositCumsOnGrid(included, grid, flowUnit) : null,
    marketDay: grid.map((ymd) => isNyseTradingDay(ymd) || isChileBusinessDay(ymd)),
  };
}

/** Build the daily series for one bucket of accounts. Throws on an out-of-bounds window. */
export function getBucketDailySeries(
  accounts: readonly ShortHorizonAccountRef[],
  opts: BucketDailySeriesOpts
): BucketDailySeries {
  const { unit } = opts;
  if (!Number.isInteger(opts.days) || opts.days < 0 || opts.days > DAILY_SERIES_MAX_DAYS) {
    throw new Error(`getBucketDailySeries: days must be 0..${DAILY_SERIES_MAX_DAYS}, got ${opts.days}`);
  }
  const now = opts.now ?? new Date();
  const endYmd = chileWallClockAt(now).ymd;
  const count = opts.days === 0 ? totalRangeDays(endYmd) : opts.days;
  // count + 1 days: [0] is the baseline anchor for the first point's delta.
  const grid = chileCalendarDaysListEndingAt(endYmd, count + 1);

  // Same value legs as `bucketValueInUnitAt` (Σ finite per-account CLP marks, converted once
  // per date), looped inline so the per-account marks can double as chart lines. The d1
  // parity test guards against divergence from the short-horizon cells.
  const included = accounts.filter(includeShortHorizonAccount);
  const perAccount: DailySeriesAccountLine[] | null = opts.includeAccounts
    ? included.map((a) => ({ account_id: a.account_id, name: a.name ?? null, values: [] }))
    : null;
  // Debt marks are positive amounts owed: they sum into `value` as displayed, and into
  // `wealth` with the opposite sign so P/L and % read as gains and losses either way.
  const isLiability = included.map((a) => isLiabilityAccountId(a.account_id));
  // Cards derive their flows from their own owed marks (see `ccDerivedFlowsClp`).
  const ccMarksClp = new Map<number, (number | null)[]>(
    included.filter((a) => isCreditCardAccountId(a.account_id)).map((a) => [a.account_id, []])
  );
  const wealth: (number | null)[] = [];
  // Marks per account for the whole grid up front: historical days come from the cached
  // series, today is computed live (see `accountMarkDailyCache.ts`).
  const marksByAccount = included.map((a) =>
    accountMarkClpSeriesOnGrid(
      {
        account_id: a.account_id,
        bucket_slug: a.bucket_slug,
        import_key: a.import_key ?? null,
        name: a.name ?? null,
      },
      grid
    )
  );
  // Per-account wealth (sign-flipped for debt) across the WHOLE grid incl. the baseline, kept
  // separate from `perAccount[].values` because those get their leading edge nulled below —
  // the P/L legs must read the untouched marks.
  const wealthByAccount: (number | null)[][] | null = perAccount
    ? included.map(() => new Array<number | null>(grid.length).fill(null))
    : null;
  // Every value is framed PER ACCOUNT (the 1D/1W cells' `accountValueInUnitAt`): a USD cash
  // account is its ledger dollars on every day; on today's grid day in USD each account's pesos
  // are framed on the day they were priced (`priced_on`); earlier days at the stored fx on or
  // before. The bucket in the unit is Σ of those, never Σ pesos ÷ one rate.
  const lastGi = grid.length - 1;
  const isUsdCash = unit === "usd" ? included.map((a) => isUsdCashAccount(a.account_id)) : null;
  const pricedOnToday =
    unit === "usd" && grid[lastGi] === chileCalendarTodayYmd()
      ? included.map(
          (a) =>
            accountTodayValue(a.account_id, a.bucket_slug, {
              import_key: a.import_key ?? null,
              name: a.name ?? null,
            })?.priced_on ?? null
        )
      : null;
  // Days before Chile today on the real clock share one rate per day across accounts and scopes.
  const realToday = chileCalendarTodayYmd();
  const pastConvert = opts.now === undefined ? pastDayUnitConverter(unit) : null;
  const usdCashPast = isUsdCash?.some(Boolean)
    ? historyTierMemo<string, number>("usd_cash_balance_usd_by_day")
    : null;
  const accountValueInUnit = (ai: number, clp: number, gi: number): number | null => {
    const ymd = grid[gi]!;
    if (isUsdCash?.[ai]) {
      const accountId = included[ai]!.account_id;
      if (!usdCashPast || ymd >= realToday) return usdCashBalanceUsdAt(accountId, ymd);
      const key = `${accountId}|${ymd}`;
      let usd = usdCashPast.get(key);
      if (usd === undefined) {
        usd = usdCashBalanceUsdAt(accountId, ymd);
        usdCashPast.set(key, usd);
      }
      return usd;
    }
    if (pastConvert && ymd < realToday) return pastConvert(clp, ymd);
    return clpToUnitAt(clp, ymd, unit, {
      now,
      markAsOf: gi === lastGi ? pricedOnToday?.[ai] ?? null : null,
    });
  };
  // Everything before the grid's last day reads evidence only (past marks, stored rates, the
  // ledger): the per-account values in the unit on past days, the flow legs and the deposit
  // cumulatives. On the real clock it is kept in the history tier, so the rebuild after a live
  // tick recomputes only today's values and the arithmetic on top.
  const flowUnit = unit === "usd" ? "usd" : "clp";
  const buildPast = (): DailySeriesPast =>
    buildDailySeriesPast(accounts, included, grid, flowUnit, marksByAccount, accountValueInUnit, !!perAccount);
  const pastKey =
    opts.now === undefined && grid[lastGi] === realToday && !dbInTransaction()
      ? dailySeriesPastKey(accounts, unit, grid, !!perAccount)
      : null;
  let past: DailySeriesPast;
  if (pastKey) {
    const memo = historyTierMemo<string, DailySeriesPast>("daily_series_past");
    const hit = memo.get(pastKey);
    past = hit ?? buildHistoryTierValue("daily series past part", buildPast);
    if (!hit) memo.set(pastKey, past);
  } else {
    past = buildPast();
  }

  /** Each account's value in the unit per grid day (null: no mark, or no rate on file). */
  const unitByAccount = included.map(() => new Array<number | null>(grid.length).fill(null));
  const values: (number | null)[] = grid.map((_ymd, gi) => {
    let sum = 0;
    let wealthSum = 0;
    let any = false;
    included.forEach((a, ai) => {
      const clp = marksByAccount[ai]![gi];
      const ok = clp != null && Number.isFinite(clp);
      ccMarksClp.get(a.account_id)?.push(ok ? clp : null);
      const u = gi < lastGi ? past.unitByAccount[ai]![gi]! : ok ? accountValueInUnit(ai, clp, gi) : null;
      const uOk = u != null && Number.isFinite(u);
      if (uOk) {
        unitByAccount[ai]![gi] = u;
        wealthSum += isLiability[ai] ? -u : u;
        sum += u;
        any = true;
      }
      if (wealthByAccount && uOk) {
        wealthByAccount[ai]![gi] = isLiability[ai] ? -u : u;
      }
      // Baseline (gi 0) anchors deltas only; account lines align with `points`.
      if (perAccount && gi >= 1) {
        perAccount[ai]!.values.push(uOk ? u : null);
      }
    });
    wealth.push(any ? wealthSum : null);
    return any ? sum : null;
  });
  // Copies: the card flows below are added into them.
  const flows = past.flows.flows.slice();
  const liabilityFlows = past.flows.liabilityFlows.slice();
  const flowsByAccount = new Map([...past.flows.byAccount].map(([id, arr]) => [id, arr.slice()]));
  for (const [accountId, marks] of ccMarksClp) {
    const derived = ccDerivedFlowsClp(accountId, grid, marks);
    for (let i = 1; i < grid.length; i++) {
      const clp = derived[i - 1]!;
      if (clp === 0) continue;
      const amt = flowEventInUnit({ occurred_on: grid[i]!, amt: clp }, flowUnit);
      liabilityFlows[i - 1] += amt;
      const arr = flowsByAccount.get(accountId) ?? new Array<number>(grid.length - 1).fill(0);
      arr[i - 1] += amt;
      flowsByAccount.set(accountId, arr);
    }
  }

  // Aportes acum. companion lines (parity with the monthly chart's deposit series): full-
  // history cumulative deposits at each day, per account plus the group total.
  let depsAcumTotal: number[] | null = null;
  let depositCumsRaw: Map<number, number[]> | null = null;
  if (perAccount) {
    const cumsById = past.depositCums!;
    const emit = (cumRaw: number, ymd: string): number =>
      unit === "uf" ? convertTs(cumRaw, ymd, "uf") : cumRaw;
    depsAcumTotal = new Array<number>(grid.length - 1).fill(0);
    depositCumsRaw = new Map();
    included.forEach((a, ai) => {
      const cums = cumsById.get(a.account_id);
      if (!cums) return;
      const raw: number[] = [];
      for (let i = 1; i < grid.length; i++) {
        const v = emit(cums[i]!, grid[i]!);
        raw.push(v);
        depsAcumTotal![i - 1]! += v;
      }
      // The line's copy gets display-trimmed below; the raw array must survive for the
      // grouped-bucket aggregation (`deposit_cums_raw`).
      perAccount[ai]!.deposits_acum = raw.slice();
      depositCumsRaw!.set(a.account_id, raw);
    });
  }

  // Per-account P/L: the same `wealth − prevWealth − flow` identity the bucket uses, on that
  // account's own legs, so the day-mode P/L bars carry the monthly chart's per-account
  // breakdown and Σ over accounts reproduces the bucket's `pl`.
  if (perAccount && wealthByAccount) {
    included.forEach((a, ai) => {
      const w = wealthByAccount[ai]!;
      const accFlows = flowsByAccount.get(a.account_id);
      const line = perAccount[ai]!;
      const pl = new Array<number | null>(grid.length - 1).fill(null);
      for (let i = 1; i < grid.length; i++) {
        const cur = w[i];
        const prev = w[i - 1];
        if (cur == null || prev == null) continue;
        const rawFlow = accFlows?.[i - 1] ?? 0;
        const flowInUnit = unit === "uf" ? convertTs(rawFlow, grid[i]!, "uf") : rawFlow;
        pl[i - 1] = cur - prev - flowInUnit;
      }
      line.pl = pl;
    });
  }

  // Display-only edge trims on the per-account chart lines, mirroring the monthly block clip so
  // a line covers the same span in both grains. `points` (and the P/L legs, which read the
  // untouched `wealthByAccount`) keep their true zeros — this shapes lines, never arithmetic.
  //
  //  - Leading: an equity/crypto account marks to a finite 0 before its first holding (0 units ×
  //    price), which would draw a flat-0 line from portfolio start; the monthly line starts at the
  //    first holding. Null the leading run of 0/null so the two agree.
  //  - Trailing: a sold-out account otherwise hugs 0 from its sell-out day through today, while
  //    the monthly ends (`applyTrailingZeroTailClipToBlock`). Keep the same number of plotted
  //    zeros (`TS_TRAILING_ZERO_MONTHS_KEPT` — one DAY at this grain) then null, and clip each
  //    line's `deposits_acum` with its value exactly as the monthly bundles the two (a sold-out
  //    account's aportes line ends with its value line rather than lingering flat).
  let chartEndYmd: string | null = null;
  if (perAccount) {
    for (const line of perAccount) trimDailyLineEdges(line);
    // All lines ended before the grid does → the chart axis should stop there (see the
    // `chart_end_ymd` field doc). `lastVisible` indexes `values`, which aligns with
    // `grid[i + 1]`; the last values index (grid.length − 2) is today.
    let lastVisible = -1;
    for (const line of perAccount) {
      for (let i = line.values.length - 1; i > lastVisible; i--) {
        if (line.values[i] != null) {
          lastVisible = i;
          break;
        }
      }
    }
    if (lastVisible >= 0 && lastVisible < grid.length - 2) {
      chartEndYmd = grid[lastVisible + 1]!;
    }
  }

  // Each account's share of the capital-base flow (assets +, debt −: borrowing grows the
  // exposure), for the members that can end a day at zero on a withdrawal.
  const baseFlowsByAccount = included.flatMap((a, ai) => {
    const accFlows = flowsByAccount.get(a.account_id);
    return accFlows ? [{ ai, accFlows, sign: isLiability[ai] ? -1 : 1 }] : [];
  });

  // Days a member held money without a value give the bucket no return (`unvaluedMemberDays`).
  const unvalued = new Array<boolean>(grid.length).fill(false);
  included.forEach((a, ai) => {
    const flagged = unvaluedMemberDays(marksByAccount[ai]!, flowsByAccount.get(a.account_id));
    for (let g = 0; g < grid.length; g++) if (flagged[g]) unvalued[g] = true;
  });

  const points: DailySeriesPoint[] = [];
  for (let i = 1; i < grid.length; i++) {
    const ymd = grid[i]!;
    const toUnit = (raw: number): number => (unit === "uf" ? convertTs(raw, ymd, "uf") : raw);
    const flow = toUnit(flows[i - 1]! + liabilityFlows[i - 1]!);
    const value = values[i]!;
    const prev = values[i - 1]!;
    const delta = value != null && prev != null ? value - prev : null;
    // P/L on wealth, so a card's intereses or a UF uptick on the mortgage read as losses:
    // for an asset-only bucket this is exactly `delta − flow`.
    const wealthNow = wealth[i]!;
    const wealthPrev = wealth[i - 1]!;
    const pl =
      wealthNow != null && wealthPrev != null && !unvalued[i]
        ? wealthNow - wealthPrev - flow
        : null;
    // Capital base = what was at work before today's P/L: assets grow with their flows, debt
    // grows with borrowing (the negated liability flow) — both are positive exposures. The
    // guard is the monthly rows' (`flowAdjustedPct`): a day that ends at zero, or whose
    // withdrawals exceed the prior close, charges them at day end instead of reading −100% or
    // dividing by a negative base — and so does each member that ends the day at zero
    // (`endChargedFlow`), so a large member emptying beside a small one still open reads its
    // own loss, not the loss over the small member's size.
    let endCharged = 0;
    for (const { ai, accFlows, sign } of baseFlowsByAccount) {
      const baseFlow = sign * accFlows[i - 1]!;
      if (!(baseFlow < 0)) continue;
      const close = unitByAccount[ai]![i];
      if (close == null || !Number.isFinite(close)) continue;
      endCharged += endChargedFlow(toUnit(baseFlow), close, unit);
    }
    const pct = flowAdjustedPct(
      pl,
      prev,
      groupStartFrameFlow(toUnit(flows[i - 1]! - liabilityFlows[i - 1]!), endCharged),
      value,
      unit
    );
    points.push({
      as_of_date: ymd,
      value,
      flow,
      delta,
      pl,
      pct,
      market_day: past.marketDay[i]!,
    });
  }

  return {
    unit,
    end_ymd: endYmd,
    baseline: { as_of_date: grid[0]!, value: values[0]! },
    points,
    ...(perAccount ? { accounts: perAccount } : {}),
    ...(depsAcumTotal ? { deposits_acum_total: depsAcumTotal } : {}),
    ...(depositCumsRaw ? { deposit_cums_raw: depositCumsRaw } : {}),
    ...(chartEndYmd ? { chart_end_ymd: chartEndYmd } : {}),
  };
}

/**
 * Agrupado view of a daily series: per-account lines summed into their chart buckets
 * (synthetic bucket ids/names from {@link ChartBucketPlan} — the same plan the monthly
 * grouped blocks use, so the client can reuse the grouped block's series metadata).
 * Accounts the plan leaves ungrouped pass through as their own lines. Pure transform over
 * an already-built series: values/P-L sum from the member lines, aportes from the pre-trim
 * `deposit_cums_raw`, and each aggregate is edge-trimmed as a unit.
 */
/**
 * Display-only edge trims on one chart line (per-account or aggregated bucket), mirroring the
 * monthly block clip so a line covers the same span in both grains:
 *  - Leading: null the run of 0/null before the first holding (an equity/crypto account marks
 *    to a finite 0 before its first buy; the monthly line starts at the first holding).
 *  - Never held in-window: the whole line is absent — its `deposits_acum` companion must null
 *    too, or a long-wound-down account draws an orphan flat aportes line with no value line.
 *    (Its raw cums still count in bucket aggregates, via `deposit_cums_raw` — display trim
 *    only shapes this account's own line.)
 *  - Trailing: a sold-out line keeps `TS_TRAILING_ZERO_MONTHS_KEPT` plotted zeros (one DAY at
 *    this grain) then nulls, bundling `deposits_acum` with the value exactly as the monthly
 *    `applyTrailingZeroTailClipToBlock` bundles the two.
 * P/L legs are untouched — they read the unclipped wealth legs (display shaping only, never
 * arithmetic).
 */
function trimDailyLineEdges(line: {
  values: (number | null)[];
  deposits_acum?: (number | null)[];
}): void {
  let firstHeld = line.values.findIndex((v) => v != null && v !== 0);
  if (firstHeld < 0) firstHeld = line.values.length; // never held: whole line absent
  for (let k = 0; k < firstHeld; k++) line.values[k] = null;
  if (firstHeld >= line.values.length) {
    if (line.deposits_acum) line.deposits_acum.fill(null);
    return;
  }
  const startNullAt = trailingZeroRunClipStartIndex(line.values);
  if (startNullAt == null) return;
  for (let k = startNullAt; k < line.values.length; k++) {
    line.values[k] = null;
    if (line.deposits_acum) line.deposits_acum[k] = null;
  }
}

export function groupDailySeriesAccounts(
  series: BucketDailySeries,
  plan: ChartBucketPlan
): DailySeriesAccountLine[] | null {
  if (!series.accounts?.length) return null;
  const pointCount = series.points.length;
  const byBucketKey = new Map<string, DailySeriesAccountLine>();
  const memberIdsByBucketKey = new Map<string, number[]>();
  const out: DailySeriesAccountLine[] = [];
  for (const line of series.accounts) {
    const bucketKey = plan.idToBucket(line.account_id);
    const meta = bucketKey != null ? plan.meta[bucketKey] : undefined;
    if (bucketKey == null || !meta) {
      out.push(line);
      continue;
    }
    let agg = byBucketKey.get(bucketKey);
    if (!agg) {
      agg = {
        account_id: meta.accountId,
        name: meta.name,
        values: new Array<number | null>(pointCount).fill(null),
      };
      byBucketKey.set(bucketKey, agg);
      memberIdsByBucketKey.set(bucketKey, []);
      out.push(agg);
    }
    memberIdsByBucketKey.get(bucketKey)!.push(line.account_id);
    // Values and P/L sum from the member lines: a trimmed value was a true 0 (leading
    // pre-holding or trailing sold-out run), so skipping the null contributes the same
    // amount, and `pl` legs are never trimmed. Deposits are NOT summed here — a trimmed
    // member's terminal cums are nonzero and must not vanish from the aggregate; they come
    // from the pre-trim `deposit_cums_raw` below.
    for (let i = 0; i < pointCount; i++) {
      const v = line.values[i];
      if (v != null) agg.values[i] = (agg.values[i] ?? 0) + v;
      const p = line.pl?.[i];
      if (p != null) {
        agg.pl ??= new Array<number | null>(pointCount).fill(null);
        agg.pl[i] = (agg.pl[i] ?? 0) + p;
      }
    }
  }
  // Bucket aportes = Σ raw (pre-trim) member cums — every member counts, wound-down and
  // never-held-in-window alike, so a bucket line's terminal deposits equal that bucket's own
  // leaf-page `deposits_acum_total` by construction. Then trim each aggregate as a unit,
  // bundling its deposits with its own value span (a fully sold-out bucket's aportes end
  // with its value line instead of lingering flat).
  const rawCums = series.deposit_cums_raw;
  for (const [bucketKey, agg] of byBucketKey) {
    if (rawCums) {
      const dep = new Array<number>(pointCount).fill(0);
      let any = false;
      for (const id of memberIdsByBucketKey.get(bucketKey)!) {
        const cums = rawCums.get(id);
        if (!cums) continue;
        any = true;
        for (let i = 0; i < pointCount; i++) dep[i] = dep[i]! + (cums[i] ?? 0);
      }
      if (any) agg.deposits_acum = dep;
    }
    trimDailyLineEdges(agg);
  }
  return out;
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
  opts: { unit: TsUnit; days: number; includeAccounts?: boolean }
): BucketDailySeries {
  const rowsKey = accounts.map((a) => a.account_id).join(",");
  const key = `daily.series|${scopeKey}|${opts.unit}|${opts.days}|${opts.includeAccounts ? "acc" : "sum"}|${rowsKey}`;
  return getAggregationCached(key, () => getBucketDailySeries(accounts, opts));
}
