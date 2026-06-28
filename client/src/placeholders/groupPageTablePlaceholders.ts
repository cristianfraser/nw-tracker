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
