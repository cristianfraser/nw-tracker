import type { FlowsTableRow } from "../accountFlows";
import type { GroupInfoTableAccount } from "../useGroupInfoConsolidatedTables";
import type { ConsolidatedMonthlyPerfRow } from "../types";
import { monthEndYmdsThroughToday } from "./placeholderMonthRows";

export function buildPlaceholderConsolidatedMonthlyRows(): ConsolidatedMonthlyPerfRow[] {
  return monthEndYmdsThroughToday().map((as_of_date) => ({
    as_of_date,
    closing_value: 0,
    prior_closing: null,
    net_capital_flow: 0,
    stock_units_inflow: 0,
    nominal_pl: null,
    pct_month: null,
    ytd_nominal_pl: null,
    cumulative_nominal_pl: null,
  }));
}

/** One zero row per child account so the flows table keeps its shape while loading. */
export function buildPlaceholderGroupFlowRows(
  tableAccounts: readonly GroupInfoTableAccount[]
): FlowsTableRow[] {
  return tableAccounts.map((a) => ({
    key: `placeholder-flow:${a.id}`,
    flow_type_label: "—",
    occurred_on: "1970-01-01",
    amount_clp: 0,
    amount_usd: null,
    ticker: null,
    units_delta: null,
    note: null,
    flow_type: "placeholder",
    account_name: a.name,
    category_slug: a.category_slug,
  }));
}
