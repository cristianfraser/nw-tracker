import { linkedCreditCardClpForCashCardAsOf } from "./linkedCreditCards.js";
import { monthEndUtcYmd, monthKeyFromYmd } from "./calendarMonth.js";
import type { ConsolidatedMonthlyPerfRow } from "./groupPerfTypes.js";
import { nettedGroup } from "./navTreeModel.js";
import { linkedCardsClpInUnit, nodeValueSeriesFromSums, type NodeNettingPolicy } from "./nodeValue.js";
import { priorCalendarMonthKey } from "./periodAnchorDates.js";
import type { TsUnit } from "./rates.js";

/**
 * Two readers of the cash netting that are not a node value of their own: the footer that
 * explains it on the netting card, and the consolidated month rows of a netting group. The rule
 * itself and its primitives are in `nodeValue.ts` (`cashNetOfLinkedCreditCards`).
 */

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

/**
 * A consolidated month closing of a netting group: the members' closing less the cards' owed
 * that day, unrounded like the rows it adjusts. A row with no prior closing reads the node's
 * empty rule at the prior month-end: 0 less what the cards owed then.
 */
const CONSOLIDATED_CLOSING_NET: NodeNettingPolicy = {
  netsLinkedCards: true,
  rounding: "none",
};

/**
 * Net linked tarjeta balance from consolidated cash_savings month cierres (chart NAV / bucket
 * level), through the node-value rules like every other cash path.
 * Nominal P/L and net_capital_flow stay savings-only; CC is a balance offset on closing/prior only.
 */
export function netLinkedCreditCardFromCashConsolidated(
  rows: readonly ConsolidatedMonthlyPerfRow[],
  unit: TsUnit
): ConsolidatedMonthlyPerfRow[] {
  if (!rows.length) return [...rows];
  const asc = [...rows].sort((a, b) => a.as_of_date.localeCompare(b.as_of_date));
  const closings = nodeValueSeriesFromSums(
    asc.map((r) => r.closing_value),
    asc.map((r) => r.as_of_date),
    unit,
    CONSOLIDATED_CLOSING_NET
  );
  const priors = nodeValueSeriesFromSums(
    asc.map((r) => (r.prior_closing != null && Number.isFinite(r.prior_closing) ? r.prior_closing : null)),
    asc.map((r) => monthEndUtcYmd(priorCalendarMonthKey(monthKeyFromYmd(r.as_of_date)))),
    unit,
    CONSOLIDATED_CLOSING_NET
  );
  return asc
    .map((row, i) => {
      const closing_value = closings[i];
      if (closing_value == null) {
        throw new Error(`consolidated cash rows: ${row.as_of_date} has no closing value to net`);
      }
      const prior_closing = priors[i];
      if (prior_closing == null) {
        throw new Error(`consolidated cash rows: ${row.as_of_date} has no prior closing to net`);
      }
      return { ...row, closing_value, prior_closing };
    })
    .reverse();
}
