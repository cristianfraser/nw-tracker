/**
 * The P/L kernel (docs/untangle-valuation-core.md, step 3): one place for the arithmetic every
 * period of every scope shares — a day of the daily series, a month row, a 1D/1W cell, a group
 * consolidation. Pure but for the currencies table (each unit's smallest coin).
 *
 * - {@link periodPl}: P/L of one period from its value legs and its flow, by the side of the
 *   balance (an asset gains when it grows beyond its flows; a debt when it shrinks beyond them).
 * - {@link cardPeriodLegs}: a credit card's period, whose P/L is its cost of financing and whose
 *   flow is everything else that moved the owed balance (`ccFinancingCostDaily.ts`).
 * - {@link flowAdjustedPct}, {@link endChargedFlow}, {@link groupStartFrameFlow}: the return over
 *   the capital at work, and how a group charges its emptied members.
 * - {@link windowIndexOf}: which half-open window `(b[i], b[i+1]]` a dated flow falls in.
 * - {@link growthFactor}, {@link compound}, {@link runningGrowth}: chaining returns.
 */
import type { TsUnit } from "./rates.js";
import { currencySmallestCoin } from "./displayUnits.js";

export type PerfSide = "asset" | "debt";

/**
 * P/L of one period: an asset's `end − start − flow` (what it grew beyond the money put in); a
 * debt's `start − end − flow` (owed falling less than it was paid is a cost: negative). Callers
 * that fold debts into a signed wealth (debt negative) use the asset rule on that wealth.
 */
export function periodPl(legs: { valueStart: number; valueEnd: number; flow: number; side: PerfSide }): number {
  return legs.side === "asset"
    ? legs.valueEnd - legs.valueStart - legs.flow
    : legs.valueStart - legs.valueEnd - legs.flow;
}

/**
 * A credit card's period: the cost is its P/L (loss-negative) and the flow is derived from the
 * balance, `−Δowed + cost` — so the debt rule {@link periodPl} gives exactly `−cost`.
 */
export function cardPeriodLegs(legs: { owedStart: number; owedEnd: number; cost: number }): { flow: number; pl: number } {
  return { flow: -(legs.owedEnd - legs.owedStart) + legs.cost, pl: -legs.cost };
}

/**
 * The zero test of the return rules, one per unit: a value at or below the unit's smallest coin
 * (`currencySmallestCoin`, from the currency's minor digits: one peso, one US or euro cent,
 * 0,0001 UF; a currency loaded later brings its own) is no capital. It decides whether a period ENDS AT ZERO and
 * whether a capital base exists at all, on every grain — month rows, the dashboard, the daily
 * series, the 1D/1W cells. Until 2026-09-27 each caller passed its own eps (0.01 in either unit
 * for the monthly rows and the dashboard, 1e-9 for the daily series and 1D/1W), so an account
 * left holding a peso of dust after a withdrawal divided the day's fx move by that peso in USD
 * and read close to −100%, and a day that STARTED on dust read a return on a one-peso base.
 */
export function zeroCloseEps(unit: TsUnit): number {
  return currencySmallestCoin(unit);
}

/**
 * Flow-adjusted return over any period — a month row, a day of the daily series, the 1D/1W
 * cells, the dashboard's day/month/year/total, an equity position's return on deposited:
 * nominal P/L over the capital at work. The default frame charges flows at the period START
 * (`denom = prior + netFlow`). Zero is the unit's coin ({@link zeroCloseEps}).
 *
 * A period that ENDS AT ZERO (`|close| ≤ coin`: a position sold off, a deposit matured, an
 * account emptied, dust left behind) was emptied by a withdrawal at its end, so it charges
 * that withdrawal at the period END and divides by the prior close: in the start frame
 * `prior + netFlow` is then exactly `−nominal`, so a loss read −100% however small and a gain
 * had no positive base. With nothing at work before it (no prior close, or dust: bought and
 * sold inside the period) there is no base → null. A period that ends at zero on a net DEPOSIT
 * keeps the start frame: that money was at work too and all of it was lost, exactly −100% (the
 * prior close alone would read a loss beyond that).
 *
 * A period that does not end at zero but whose net withdrawal exceeds the prior close (a
 * partial liquidation that takes the period's gains too) also divides by the prior close,
 * the start denominator being ≤ 0. Null when no positive capital base exists in either
 * frame — among them a first period (no prior close) whose flows are net withdrawals — and
 * when the close is unknown (the frame cannot be chosen).
 *
 * `netFlow` is the flow charged at the period START: an account's whole net flow; a group's
 * {@link groupStartFrameFlow}.
 */
export function flowAdjustedPct(
  nominal: number | null,
  prior: number | null,
  netFlow: number,
  close: number | null,
  unit: TsUnit
): number | null {
  if (nominal == null || !Number.isFinite(nominal)) return null;
  if (close == null || !Number.isFinite(close)) return null;
  const eps = zeroCloseEps(unit);
  const priorBase = prior != null && Number.isFinite(prior) ? prior : 0;
  const endsAtZero = Math.abs(close) <= eps;
  if (endsAtZero && !(priorBase > eps)) return null;
  const startFrameDenom = priorBase + netFlow;
  const denom =
    endsAtZero && netFlow <= 0
      ? priorBase
      : startFrameDenom > eps
        ? startFrameDenom
        : priorBase > eps
          ? priorBase
          : null;
  if (denom == null) return null;
  const pct = nominal / denom;
  return Number.isFinite(pct) ? pct : null;
}

/**
 * The part of one member's net flow a group return may charge at the period end: all of it
 * when the member ends at zero on a net withdrawal (the rule {@link flowAdjustedPct} applies to
 * that member alone), else 0. Summed over the members and passed to {@link groupStartFrameFlow}.
 */
export function endChargedFlow(netFlow: number, close: number | null, unit: TsUnit): number {
  if (close == null || !Number.isFinite(close) || !Number.isFinite(netFlow)) return 0;
  return Math.abs(close) <= zeroCloseEps(unit) && netFlow <= 0 ? netFlow : 0;
}

/**
 * The flow a GROUP return charges at the period start (the `netFlow` argument of
 * {@link flowAdjustedPct}): its net flow minus what its emptied members withdrew
 * (`endChargedSum`, Σ {@link endChargedFlow}), so each member's zero close carries into the
 * group — a large member sold off at a small loss beside a small one still open used to leave
 * the group base at about the small member's size, so the group read a loss of tens of percent
 * while the member it came from read a fraction of one.
 *
 * Only money that LEFT the group is charged at the end: the end charge is capped at the group's
 * own net withdrawal. A member emptied into another member of the group is a transfer the group
 * net already cancels, and the receiving member counts that money at the start — charging the
 * emptied side at the end as well would count the same capital twice.
 *
 * No member empties → `netFlow` unchanged, the start frame as before. A single account → its
 * whole withdrawal when it empties, the account's own rule.
 */
export function groupStartFrameFlow(netFlow: number, endChargedSum: number): number {
  return netFlow - Math.max(endChargedSum, Math.min(netFlow, 0));
}

/**
 * The index `i` of the window `(boundaries[i], boundaries[i + 1]]` a date falls in, or −1 outside
 * every window. `boundaries` ascending; binary search.
 */
export function windowIndexOf(boundaries: readonly string[], ymd: string): number {
  const n = boundaries.length;
  if (n < 2 || ymd <= boundaries[0]! || ymd > boundaries[n - 1]!) return -1;
  // First i ≥ 1 with boundaries[i] ≥ ymd → window i − 1.
  let lo = 1;
  let hi = n - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (boundaries[mid]! >= ymd) hi = mid;
    else lo = mid + 1;
  }
  return lo - 1;
}

/** Π(1 + r) over the finite returns, and whether there was one. */
export function growthFactor(returns: Iterable<number | null | undefined>): { factor: number; any: boolean } {
  let factor = 1;
  let any = false;
  for (const r of returns) {
    if (r == null || !Number.isFinite(r)) continue;
    factor *= 1 + r;
    any = true;
  }
  return { factor, any };
}

/** The compound of the returns, Π(1 + r) − 1; null when none is finite. */
export function compound(returns: Iterable<number | null | undefined>): number | null {
  const g = growthFactor(returns);
  return g.any ? g.factor - 1 : null;
}

/**
 * The running growth Π(1 + r) after each return (a missing return is flat), and whether any
 * return has been seen by then.
 */
export function runningGrowth(returns: readonly (number | null | undefined)[]): { factor: number; any: boolean }[] {
  let factor = 1;
  let any = false;
  return returns.map((r) => {
    if (r != null && Number.isFinite(r)) {
      factor *= 1 + r;
      any = true;
    }
    return { factor, any };
  });
}
