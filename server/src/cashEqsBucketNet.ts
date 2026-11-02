import { db } from "./db.js";
import { clpToUnitAt } from "./clpToUnitAt.js";
import { linkedCreditCardClpForCashCardAsOf } from "./liabilityTree.js";
import { monthEndUtcYmd, monthKeyFromYmd } from "./calendarMonth.js";
import { priorCalendarMonthKey } from "./accountPeriodMarks.js";
import type { ConsolidatedMonthlyPerfRow } from "./groupMonthlyPerfConsolidation.js";
import type { TsUnit } from "./groupMonthlyPerfConsolidation.js";

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

/** The linked cards' owed in the unit at that day, at the debt side (today: the live rate). NaN without a rate. */
function convertLinkedCc(clp: number, asOf: string, unit: TsUnit): number {
  if (unit === "clp") return clp;
  if (unit === "usd") {
    const usd = clpToUnitAt(clp, asOf, "usd", { side: "debt" });
    return usd != null && Number.isFinite(usd) ? usd : Number.NaN;
  }
  return clp;
}

export type DashboardLinkedBalanceDto = {
  slug: string;
  label: string;
  label_i18n_key: string;
  clp: number;
  usd: number | null;
  route_path: string;
};

/**
 * Tarjeta de crédito balance shown linked to the Ahorros y reservas home card — the footer
 * that explains why the card's header (`cashNetOfLinkedCreditCards`) differs from Σ savings.
 * Shown whenever the linked total is non-zero, a total in credit too (as a negative owed):
 * the header counts the credit, so hiding it would leave that difference unexplained.
 */
export function cashSavingsLinkedBalances(
  asOfYmd: string,
  includeUsd: boolean
): DashboardLinkedBalanceDto[] {
  const cc = linkedCreditCardClpForCashCardAsOf(asOfYmd);
  if (cc === 0) return [];
  const usd = includeUsd ? clpToUnitAt(cc, asOfYmd, "usd", { side: "debt" }) : null;
  const node = db
    .prepare(`SELECT route_path FROM portfolio_groups WHERE slug = 'liabilities_credit_card'`)
    .get() as { route_path: string | null } | undefined;
  const routePath = node?.route_path?.trim();
  if (!routePath) throw new Error("nav node liabilities_credit_card has no route_path (run the nav seed)");
  return [
    {
      slug: "credit_card",
      label: "Credit card",
      label_i18n_key: "liabilities.creditCard",
      clp: cc,
      usd: usd != null && Number.isFinite(usd) ? usd : null,
      route_path: routePath,
    },
  ];
}

function linkedCcOffsetAt(asOf: string, unit: TsUnit): number {
  const ccClp = linkedCreditCardClpForCashCardAsOf(asOf);
  const v = convertLinkedCc(ccClp, asOf, unit);
  return Number.isFinite(v) ? v : 0;
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
      const linkedCcClose = linkedCcOffsetAt(row.as_of_date, unit);
      let prior_closing = row.prior_closing;
      if (prior_closing != null && Number.isFinite(prior_closing)) {
        const priorEnd = priorMonthEndYmdForConsolidatedRow(row.as_of_date);
        const linkedCcPrior = linkedCcOffsetAt(priorEnd, unit);
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
