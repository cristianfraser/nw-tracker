/**
 * The value of a nav node (a portfolio group, a bucket, a chart line) at a date in a display
 * unit: Σ of its member accounts' values in that unit, less the linked credit cards' owed when
 * the node nets them (signed: cards in credit add). Exact: never rounded here.
 *
 * Every reader of that sum goes through here. What the readers disagree on is not hidden in
 * branches: each passes a {@link NodeValuePolicy} naming its netting. One empty
 * rule for all: a node with no member value that day is absent (null), except a netting node,
 * which reads 0 less the cards' owed. Linked cards that owe with no rate into the unit that day
 * throw, for every reader.
 *
 * Forms:
 * - {@link nodeValue}: one date.
 * - {@link nodeValuesAtDates}: a list of dates (month-ends), one point read per date.
 * - {@link nodeValueSeriesOnGrid}: a contiguous Chile-day grid, from the per-account daily cache.
 * - {@link nodeValueSeriesFromSums} / {@link nodeValueFromSum}: the same netting and empty rule
 *   for a reader that already holds the members' sum (a group's own daily series,
 *   the consolidated month closings, dashboard rows); {@link nodeMembersSum} is that sum.
 *
 * The netting primitives live here too ({@link cashNetOfLinkedCreditCards},
 * {@link linkedCardsOwedInUnit}, {@link nodeNetsLinkedCards}).
 *
 * Every returned number is in the `unit` argument. Sits on the account value, the daily cache,
 * the linked-card totals and the netting roles only — below the nav tree builders and the group
 * consolidation.
 */
import { accountValueSeriesOnGrid } from "./accountMarkDailyCache.js";
import { accountValueAt } from "./accountValue.js";
import { linkedCreditCardClpForCashCardAsOf, linkedCreditCardClpForCashCardByDates } from "./linkedCreditCards.js";
import { nettingGroupOf } from "./navTreeModel.js";
import type { CurrencyCode } from "./rates.js";
import { clpToUnitAt } from "./valueConvert.js";

/** An account of a node, as the group listings return it. */
export type NodeValueMember = {
  account_id: number;
  exclude_from_group_totals?: number;
};

/**
 * The one netting rule: a netting node's value is its members' sum less the linked cards' owed,
 * both in the same unit — the ONE place the linked-card total enters a cash value.
 *
 * Signed, never clamped. The linked total is the cards' owed-on-date sum, and an overpaid card
 * owes a NEGATIVE amount — money the bank holds for you — so a total in credit ADDS to cash. A
 * clamp on one path only would make the live card and its prior-day close disagree by exactly
 * the credit (a phantom day change).
 */
export function cashNetOfLinkedCreditCards(rawCash: number, linkedCreditCardsOwed: number): number {
  return rawCash - linkedCreditCardsOwed;
}

/**
 * The linked cards' peso total `clp` of `ymd` in `unit`, at the debt side (today: the live rate).
 * Cards owing nothing need no rate; a total with no rate into the unit that day throws.
 */
export function linkedCardsClpInUnit(clp: number, ymd: string, unit: CurrencyCode): number {
  if (clp === 0) return 0;
  const v = clpToUnitAt(clp, ymd, unit, { side: "debt" });
  if (v == null || !Number.isFinite(v)) {
    throw new Error(`linked credit cards: no ${unit} rate on ${ymd} for what they owe`);
  }
  return v;
}

/**
 * The linked cards' owed at `ymd` in `unit`, at the debt side (today: the live rate): what a
 * netting node subtracts. Throws when they owe and the unit has no rate that day.
 */
export function linkedCardsOwedInUnit(ymd: string, unit: CurrencyCode): number {
  return linkedCardsClpInUnit(linkedCreditCardClpForCashCardAsOf(ymd), ymd, unit);
}

/**
 * How a node is valued, shared by every form: whether it nets the linked cards. Nothing else
 * varies between readers — no empty option (the one rule above), no rounding (a node's value is
 * exact; a builder that prints a total beside its parts rounds there, `coinApportionment.ts`) and
 * no clock (today reads the shared live-tier value and the live rate, the same figure for every
 * reader in the same minute).
 */
export type NodeValuePolicy = {
  /** The node subtracts the linked cards' owed ({@link nodeNetsLinkedCards} for a group). */
  netsLinkedCards: boolean;
};

/**
 * Whether the group nets the linked credit cards: it is the node that declares the netting
 * (`nets_linked_group_id`, one node of the tree) or the net-worth bucket that holds it
 * (`nettingGroupOf`). The one place a policy's `netsLinkedCards` comes from for a group, a bucket
 * and a chart line alike — lines that split a bucket cover disjoint subtrees, so one of them nets.
 */
export function nodeNetsLinkedCards(groupSlug: string): boolean {
  return nettingGroupOf(groupSlug) != null;
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

function memberValueAt(m: NodeValueMember, ymd: string, unit: CurrencyCode): number | null {
  return finite(accountValueAt(m.account_id, ymd, unit)?.value);
}

/**
 * Σ of the member values that exist (finite), in order from 0; null when none does. The one sum
 * every form reads, also for a reader that holds its members' values already (the daily series).
 */
export function nodeMembersSum(values: Iterable<number | null | undefined>): number | null {
  let sum = 0;
  let any = false;
  for (const v of values) {
    if (v == null || !Number.isFinite(v)) continue;
    sum += v;
    any = true;
  }
  return any ? sum : null;
}

/**
 * The rule kernel: a members' sum (null: no member had a value) and the linked cards' owed in
 * the same unit (`undefined`: the node does not net) to the node's value. The one empty rule: no
 * member value reads absent, except on a netting node, which reads 0 less the cards' owed.
 */
export function nodeValueFromSum(sum: number | null, linkedCardsOwed: number | undefined): number | null {
  if (linkedCardsOwed !== undefined) return cashNetOfLinkedCreditCards(sum ?? 0, linkedCardsOwed);
  return sum;
}

/** The linked cards' owed in `unit` on each date, at the debt side. One batch read. */
function linkedCardsOwedOnDates(dates: readonly string[], unit: CurrencyCode): number[] {
  const clpByDate = linkedCreditCardClpForCashCardByDates([...new Set(dates)].sort());
  return dates.map((ymd) => {
    const clp = clpByDate.get(ymd);
    if (clp == null) throw new Error(`linked credit cards: no owed total for ${ymd}`);
    return linkedCardsClpInUnit(clp, ymd, unit);
  });
}

/** The node's value on `ymd` in `unit`. */
export function nodeValue(
  members: readonly NodeValueMember[],
  ymd: string,
  unit: CurrencyCode,
  policy: NodeValuePolicy
): number | null {
  const sum = nodeMembersSum(nodeValueMembers(members).map((m) => memberValueAt(m, ymd, unit)));
  const owed = policy.netsLinkedCards ? linkedCardsOwedInUnit(ymd, unit) : undefined;
  return nodeValueFromSum(sum, owed);
}

/**
 * The node's value in `unit` on each of `dates` (any dates, e.g. month-ends), index-aligned.
 * One point read per member per date: for a few hundred dates, not a daily grid.
 */
export function nodeValuesAtDates(
  members: readonly NodeValueMember[],
  dates: readonly string[],
  unit: CurrencyCode,
  policy: NodeValuePolicy
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
  const series = nodeValueMembers(members).map((m) => accountValueSeriesOnGrid({ account_id: m.account_id }, grid, unit));
  const sums = grid.map((_, gi) => nodeMembersSum(series.map((values) => values[gi])));
  return nodeValueSeriesFromSums(sums, grid, unit, policy);
}

/**
 * The node's value in `unit` on each date, given its members' sum per date (null: none had a
 * value): the netting and the empty rule of the other forms.
 */
export function nodeValueSeriesFromSums(
  sums: readonly (number | null)[],
  dates: readonly string[],
  unit: CurrencyCode,
  policy: NodeValuePolicy
): (number | null)[] {
  if (sums.length !== dates.length) {
    throw new Error(`node value: ${sums.length} sums for ${dates.length} dates`);
  }
  if (!policy.netsLinkedCards) return [...sums];
  const owed = linkedCardsOwedOnDates(dates, unit);
  return sums.map((sum, i) => nodeValueFromSum(sum, owed[i]!));
}
