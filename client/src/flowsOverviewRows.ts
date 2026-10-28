import type { FlowsOverviewRow, FlowsOverviewTotals } from "./types";

/**
 * Every figure of a flows overview row. The server derives savings, card net, cash unexplained,
 * investments and net-worth change from the base legs (`derivedFlowsOverviewFields`); each is a
 * linear combination of them, so a Σ of server rows field by field IS the derivation over the
 * summed legs. The client only sums the server's figures: it holds no copy of the rule.
 */
const FIELDS = [
  "income",
  "expenses",
  "savings",
  "deposits",
  "deposits_pre_tax",
  "card_spent",
  "card_paid",
  "card_net",
  "cash_change",
  "cash_unexplained",
  "pl",
  "investments_change",
  "net_worth_change",
] as const satisfies readonly (keyof FlowsOverviewTotals)[];

// A field added to the DTO and not listed here fails to compile.
type MissingField = Exclude<keyof FlowsOverviewTotals, (typeof FIELDS)[number]>;
const ALL_FIELDS_LISTED: MissingField extends never ? true : never = true;
void ALL_FIELDS_LISTED;

function zeroTotals(): FlowsOverviewTotals {
  const out = {} as FlowsOverviewTotals;
  for (const f of FIELDS) out[f] = 0;
  return out;
}

function addRow(into: FlowsOverviewTotals, row: FlowsOverviewTotals): void {
  for (const f of FIELDS) into[f] += row[f];
}

/**
 * Yearly rows from the server's month rows (Σ per field). The chart feeds it through
 * `clipMonthsThenRollup`, so a Rango that starts mid-year gives a partial first year.
 */
export function rollupFlowsOverviewRowsByYear(rows: readonly FlowsOverviewRow[]): FlowsOverviewRow[] {
  const byYear = new Map<string, FlowsOverviewTotals>();
  for (const row of rows) {
    const year = row.period_month.slice(0, 4);
    let t = byYear.get(year);
    if (!t) {
      t = zeroTotals();
      byYear.set(year, t);
    }
    addRow(t, row);
  }
  return [...byYear.keys()]
    .sort()
    .map((year) => ({ period_month: `${year}-12`, as_of_date: `${year}-12-31`, ...byYear.get(year)! }));
}

/**
 * The «en el rango» companion: Σ of the rows the chart's Rango kept (full history is the
 * server's `totals`). The clip stays on the client because every chart picks its own Rango.
 */
export function flowsOverviewRangeTotals(rows: readonly FlowsOverviewRow[]): FlowsOverviewTotals {
  const t = zeroTotals();
  for (const row of rows) addRow(t, row);
  return t;
}

/** Zero totals: a frame drawn before the payload lands. */
export const ZERO_FLOWS_OVERVIEW_TOTALS: FlowsOverviewTotals = zeroTotals();
