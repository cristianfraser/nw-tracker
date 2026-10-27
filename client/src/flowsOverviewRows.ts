import type { FlowsOverviewRow, FlowsOverviewTotals } from "./types";

/** The legs that are flows on their own (they sum); the rest are derived from them. */
type BaseLegs = Pick<
  FlowsOverviewTotals,
  "income" | "expenses" | "deposits" | "deposits_pre_tax" | "card_spent" | "card_paid" | "cash_change" | "pl"
>;

const ZERO_LEGS: BaseLegs = {
  income: 0,
  expenses: 0,
  deposits: 0,
  deposits_pre_tax: 0,
  card_spent: 0,
  card_paid: 0,
  cash_change: 0,
  pl: 0,
};

function addLegs(into: BaseLegs, row: BaseLegs): void {
  into.income += row.income;
  into.expenses += row.expenses;
  into.deposits += row.deposits;
  into.deposits_pre_tax += row.deposits_pre_tax;
  into.card_spent += row.card_spent;
  into.card_paid += row.card_paid;
  into.cash_change += row.cash_change;
  into.pl += row.pl;
}

/** The derived fields from summed legs — the server's rule (`derivedFlowsOverviewFields`). */
function withDerived(l: BaseLegs): FlowsOverviewTotals {
  const savings = l.income - l.expenses;
  return {
    ...l,
    savings,
    card_net: l.card_spent - l.card_paid,
    cash_unexplained: l.cash_change - (savings - l.deposits + l.card_spent - l.card_paid),
    investments_change: l.deposits + l.deposits_pre_tax + l.pl,
    net_worth_change: savings + l.deposits_pre_tax + l.pl,
  };
}

/**
 * Yearly rows from the server's month rows: the legs sum, the derived fields are re-derived. The
 * chart feeds it through `clipMonthsThenRollup`, so a Rango that starts mid-year gives a partial
 * first year.
 */
export function rollupFlowsOverviewRowsByYear(rows: readonly FlowsOverviewRow[]): FlowsOverviewRow[] {
  const byYear = new Map<string, BaseLegs>();
  for (const row of rows) {
    const year = row.period_month.slice(0, 4);
    let legs = byYear.get(year);
    if (!legs) {
      legs = { ...ZERO_LEGS };
      byYear.set(year, legs);
    }
    addLegs(legs, row);
  }
  return [...byYear.keys()]
    .sort()
    .map((year) => ({ period_month: `${year}-12`, as_of_date: `${year}-12-31`, ...withDerived(byYear.get(year)!) }));
}

/** The «en el rango» companion: Σ of the rows the chart's Rango kept (full history is the server's). */
export function flowsOverviewRangeTotals(rows: readonly FlowsOverviewRow[]): FlowsOverviewTotals {
  const legs = { ...ZERO_LEGS };
  for (const row of rows) addLegs(legs, row);
  return withDerived(legs);
}

/** Zero totals: a frame drawn before the payload lands. */
export const ZERO_FLOWS_OVERVIEW_TOTALS: FlowsOverviewTotals = withDerived(ZERO_LEGS);
