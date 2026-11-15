import { nettedGroup, nettingGroupWithin } from "./navTreeModel.js";
import { clpToUnitAt } from "./valueConvert.js";
import { linkedCreditCardClpForCashCardAsOf } from "./linkedCreditCards.js";
import { monthEndUtcYmd, monthKeyFromYmd } from "./calendarMonth.js";
import { priorCalendarMonthKey } from "./periodAnchorDates.js";
import type { ConsolidatedMonthlyPerfRow } from "./groupPerfTypes.js";
import type { TsUnit } from "./rates.js";

/**
 * The cash bucket («Efectivo» / cash_eqs) net of its linked credit cards — the ONE place the
 * linked-card total (`linkedCreditCardClpForCashCardAsOf` / `…ByDates`) enters a cash value.
 * Every path goes through it: the live card and its month/year/day prior closes
 * (`portfolioGroupValueAtDate.ts`, via the group consolidation below for live/month/year),
 * the daily series (`buildDashboardBucketDailySeriesClp`), the monthly chart totals
 * (`slugMarkTotalsAtDatesClp`) and the daily reference overlays (`dailyReferenceLines.ts`).
 *
 * Signed, never clamped. The linked total is the cards' owed-on-date sum, and an overpaid
 * card owes a NEGATIVE amount — money the bank holds for you — so a total in credit ADDS to
 * cash. A clamp that ignored the credit on some paths while the consolidation counted it made
 * the live card and its prior-day close disagree by exactly the credit (a phantom day change),
 * and the daily/monthly charts disagree with the card, whenever the linked cards were net in
 * credit.
 *
 * Unrounded and unit-agnostic (both legs in the caller's unit — the consolidation nets in USD
 * too): each caller rounds once at its end, the same way it rounds every other bucket's Σ.
 */
export function cashNetOfLinkedCreditCards(rawCash: number, linkedCreditCardsOwed: number): number {
  return rawCash - linkedCreditCardsOwed;
}

/**
 * True when the group's value nets the linked cards: the node that declares the netting
 * (`nets_linked_group_id`) is the group or sits inside it.
 */
export function groupNetsLinkedCards(slug: string): boolean {
  return nettingGroupWithin(slug) != null;
}

/**
 * The linked cards' peso total `clp` of `ymd` in `unit`, at the debt side (today: the live rate).
 * Cards owing nothing need no rate; a total with no rate into the unit that day throws.
 */
export function linkedCardsClpInUnit(clp: number, ymd: string, unit: TsUnit, opts: { now?: Date } = {}): number {
  if (clp === 0) return 0;
  const v = clpToUnitAt(clp, ymd, unit, { side: "debt", ...(opts.now ? { now: opts.now } : {}) });
  if (v == null || !Number.isFinite(v)) {
    throw new Error(`linked credit cards: no ${unit} rate on ${ymd} for what they owe`);
  }
  return v;
}

/**
 * The linked cards' owed at `ymd` in `unit`, at the debt side (today: the live rate): what a
 * netting group subtracts. Throws when they owe and the unit has no rate that day.
 */
export function linkedCardsOwedInUnit(ymd: string, unit: TsUnit, opts: { now?: Date } = {}): number {
  return linkedCardsClpInUnit(linkedCreditCardClpForCashCardAsOf(ymd), ymd, unit, opts);
}

export type DashboardLinkedBalanceDto = {
  slug: string;
  label: string;
  label_i18n_key: string;
  /** In the payload's unit. */
  value: number;
  route_path: string;
};

/**
 * Tarjeta de crédito balance shown linked to the Ahorros y reservas home card — the footer
 * that explains why the card's header (`cashNetOfLinkedCreditCards`) differs from Σ savings.
 * Shown whenever the linked total is non-zero, a total in credit too (as a negative owed):
 * the header counts the credit, so hiding it would leave that difference unexplained.
 */
export function cashSavingsLinkedBalances(asOfYmd: string, unit: TsUnit): DashboardLinkedBalanceDto[] {
  const cc = linkedCreditCardClpForCashCardAsOf(asOfYmd);
  if (cc === 0) return [];
  const value = linkedCardsClpInUnit(cc, asOfYmd, unit);
  const linked = nettedGroup();
  const routePath = linked.routePath?.trim();
  if (!routePath) throw new Error(`nav node ${linked.slug} has no route_path (run the nav seed)`);
  return [
    {
      slug: "credit_card",
      label: "Credit card",
      label_i18n_key: "liabilities.creditCard",
      value,
      route_path: routePath,
    },
  ];
}

function priorMonthEndYmdForConsolidatedRow(asOf: string): string {
  const mk = monthKeyFromYmd(asOf);
  return monthEndUtcYmd(priorCalendarMonthKey(mk));
}

/**
 * Net linked tarjeta balance from consolidated cash_savings month cierres (chart NAV / bucket
 * level), through {@link cashNetOfLinkedCreditCards} like every other cash path.
 * Nominal P/L and net_capital_flow stay savings-only; CC is a balance offset on closing/prior only.
 */
export function netLinkedCreditCardFromCashConsolidated(
  rows: readonly ConsolidatedMonthlyPerfRow[],
  unit: TsUnit
): ConsolidatedMonthlyPerfRow[] {
  if (!rows.length) return [...rows];

  return [...rows]
    .sort((a, b) => a.as_of_date.localeCompare(b.as_of_date))
    .map((row) => {
      const linkedCcClose = linkedCardsOwedInUnit(row.as_of_date, unit);
      let prior_closing = row.prior_closing;
      if (prior_closing != null && Number.isFinite(prior_closing)) {
        const priorEnd = priorMonthEndYmdForConsolidatedRow(row.as_of_date);
        const linkedCcPrior = linkedCardsOwedInUnit(priorEnd, unit);
        prior_closing = cashNetOfLinkedCreditCards(prior_closing, linkedCcPrior);
      }
      return {
        ...row,
        closing_value: cashNetOfLinkedCreditCards(row.closing_value, linkedCcClose),
        prior_closing,
      };
    })
    .reverse();
}
