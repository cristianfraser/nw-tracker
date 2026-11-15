/**
 * The value of a nav node (a portfolio group, a bucket, a chart line) at a date in a display
 * unit: Σ of its member accounts' values in that unit, less the linked credit cards' owed when
 * the node nets them (signed: cards in credit add), rounded once.
 *
 * Every reader of that sum goes through here. What the readers disagree on is not hidden in
 * branches: each passes a {@link NodeValuePolicy} naming its netting, what an all-missing node reads and its rounding. Linked cards that owe with no rate
 * into the unit that day throw, for every reader.
 *
 * Forms:
 * - {@link nodeValue}: one date.
 * - {@link nodeValuesAtDates}: a list of dates (month-ends), one point read per date.
 * - {@link nodeValueSeriesOnGrid}: a contiguous Chile-day grid, from the per-account daily cache.
 * - {@link nodeValueSeriesFromSums} / {@link nodeValueFromSum}: the same netting, empty and
 *   rounding rules for a reader that already holds the members' sum (a group's own daily series,
 *   dashboard rows).
 *
 * Every returned number is in the `unit` argument. Sits on the account value, the daily cache,
 * the linked-card totals and the netting roles only — below the nav tree builders and the group
 * consolidation.
 */
import { accountValueSeriesOnGrid } from "./accountMarkDailyCache.js";
import { accountValueAt } from "./accountValue.js";
import {
  cashNetOfLinkedCreditCards,
  groupNetsLinkedCards,
  linkedCardsClpInUnit,
  linkedCardsOwedInUnit,
} from "./cashEqsBucketNet.js";
import { roundToCurrency } from "./displayUnits.js";
import { linkedCreditCardClpForCashCardByDates } from "./linkedCreditCards.js";
import type { CurrencyCode } from "./rates.js";

/** An account of a node, as the group listings return it. */
export type NodeValueMember = {
  account_id: number;
  bucket_slug: string;
  import_key?: string | null;
  name?: string | null;
  exclude_from_group_totals?: number;
};

/**
 * What a node reads when no member has a value that day.
 * - `null`: absent, even when it nets linked cards.
 * - `null_unless_netted`: absent, except a netting node, which reads 0 less the cards' owed.
 * - `zero`: 0 (then netted, if it nets).
 */
export type NodeEmptyRule = "null" | "null_unless_netted" | "zero";

/** `unit_coin`: rounded once, after netting, to the unit's smallest coin. */
export type NodeRounding = "none" | "unit_coin";

/** The rules applied to a members' sum. */
export type NodeValueRules = {
  empty: NodeEmptyRule;
  rounding: NodeRounding;
};

/** Netting and clock, shared by every form. */
export type NodeNettingPolicy = NodeValueRules & {
  /** The node subtracts the linked cards' owed ({@link nodeNetsLinkedCards} for a group). */
  netsLinkedCards: boolean;
  /**
   * The caller's clock for today's values and rates. Left out, today reads the shared
   * live-tier value and the live rate.
   */
  now?: Date;
};

/** A node valued from the daily cache (the grid form). */
export type NodeValuePolicy = NodeNettingPolicy;

/**
 * A node valued by point reads: each member's value is what the account held that day,
 * converted once into the unit at its side (`accountValueAt`) — the figure the daily cache holds.
 */
export type NodePointValuePolicy = NodeValuePolicy;

/**
 * Whether the group nets the linked credit cards: the node that declares the netting
 * (`nets_linked_group_id`, one node of the tree) is the group or sits inside it. The one place a
 * policy's `netsLinkedCards` comes from for a group, a bucket and a chart line alike — lines that
 * split a bucket cover disjoint subtrees, so exactly one of them nets.
 */
export function nodeNetsLinkedCards(groupSlug: string): boolean {
  return groupNetsLinkedCards(groupSlug);
}

/**
 * The members a node counts, in their order: real accounts (id > 0; a synthetic chart line has
 * no value of its own) not flagged `exclude_from_group_totals`.
 */
export function nodeValueMembers<M extends NodeValueMember>(members: readonly M[]): M[] {
  return members.filter((m) => m.account_id > 0 && m.exclude_from_group_totals !== 1);
}

function finite(v: number | null | undefined): number | null {
  return v != null && Number.isFinite(v) ? v : null;
}

function memberValueAt(m: NodeValueMember, ymd: string, unit: CurrencyCode, now: Date | undefined): number | null {
  return finite(accountValueAt(m.account_id, ymd, unit, { now })?.value);
}

/** Σ of the values that exist, in order from 0; null when none does. */
function sumOrNull(values: Iterable<number | null>): number | null {
  let sum = 0;
  let any = false;
  for (const v of values) {
    if (v == null) continue;
    sum += v;
    any = true;
  }
  return any ? sum : null;
}

/**
 * The rule kernel: a members' sum (null: no member had a value) and the linked cards' owed in
 * the same unit (`undefined`: the node does not net) to the node's value.
 */
export function nodeValueFromSum(
  sum: number | null,
  linkedCardsOwed: number | undefined,
  unit: CurrencyCode,
  rules: NodeValueRules
): number | null {
  const nets = linkedCardsOwed !== undefined;
  let value: number;
  if (sum == null) {
    if (rules.empty === "null") return null;
    if (rules.empty === "null_unless_netted" && !nets) return null;
    value = 0;
  } else {
    value = sum;
  }
  if (nets) value = cashNetOfLinkedCreditCards(value, linkedCardsOwed);
  return rules.rounding === "unit_coin" ? roundToCurrency(value, unit) : value;
}

/** The linked cards' owed in `unit` on each date, at the debt side. One batch read. */
function linkedCardsOwedOnDates(dates: readonly string[], unit: CurrencyCode, now: Date | undefined): number[] {
  const clpByDate = linkedCreditCardClpForCashCardByDates([...dates]);
  return dates.map((ymd) => linkedCardsClpInUnit(clpByDate.get(ymd) ?? 0, ymd, unit, now ? { now } : {}));
}

/** The node's value on `ymd` in `unit`. */
export function nodeValue(
  members: readonly NodeValueMember[],
  ymd: string,
  unit: CurrencyCode,
  policy: NodePointValuePolicy
): number | null {
  const sum = sumOrNull(
    nodeValueMembers(members).map((m) => memberValueAt(m, ymd, unit, policy.now))
  );
  const owed = policy.netsLinkedCards
    ? linkedCardsOwedInUnit(ymd, unit, policy.now ? { now: policy.now } : {})
    : undefined;
  return nodeValueFromSum(sum, owed, unit, policy);
}

/**
 * The node's value in `unit` on each of `dates` (any dates, e.g. month-ends), index-aligned.
 * One point read per member per date: for a few hundred dates, not a daily grid.
 */
export function nodeValuesAtDates(
  members: readonly NodeValueMember[],
  dates: readonly string[],
  unit: CurrencyCode,
  policy: NodePointValuePolicy
): (number | null)[] {
  const rows = nodeValueMembers(members);
  return dates.map((ymd) => nodeValue(rows, ymd, unit, policy));
}

/**
 * The node's value in `unit` on each day of `grid` (contiguous ascending Chile days),
 * index-aligned, from each member's cached daily series (`accountValueSeriesOnGrid`).
 */
export function nodeValueSeriesOnGrid(
  members: readonly NodeValueMember[],
  grid: readonly string[],
  unit: CurrencyCode,
  policy: NodeValuePolicy
): (number | null)[] {
  const series = nodeValueMembers(members).map((m) =>
    accountValueSeriesOnGrid(
      { account_id: m.account_id, bucket_slug: m.bucket_slug, import_key: m.import_key ?? null, name: m.name ?? null },
      grid,
      unit
    )
  );
  const sums = grid.map((_, gi) => {
    let sum = 0;
    let any = false;
    for (const values of series) {
      const v = values[gi];
      if (v == null || !Number.isFinite(v)) continue;
      sum += v;
      any = true;
    }
    return any ? sum : null;
  });
  return nodeValueSeriesFromSums(sums, grid, unit, policy);
}

/**
 * The node's value in `unit` on each date, given its members' sum per date (null: none had a
 * value): the netting, empty and rounding rules of the other forms.
 */
export function nodeValueSeriesFromSums(
  sums: readonly (number | null)[],
  dates: readonly string[],
  unit: CurrencyCode,
  policy: NodeNettingPolicy
): (number | null)[] {
  if (sums.length !== dates.length) {
    throw new Error(`node value: ${sums.length} sums for ${dates.length} dates`);
  }
  const owed = policy.netsLinkedCards ? linkedCardsOwedOnDates(dates, unit, policy.now) : null;
  return dates.map((_, i) => nodeValueFromSum(sums[i]!, owed ? owed[i]! : undefined, unit, policy));
}
