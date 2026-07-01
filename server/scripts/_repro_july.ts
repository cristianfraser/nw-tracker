import { chileCalendarTodayYmd } from "../src/chileDate.js";
import { buildNetWorthConsolidatedMonthly } from "../src/netWorthConsolidation.js";

console.log("today =", chileCalendarTodayYmd());
const rows = buildNetWorthConsolidatedMonthly("clp");
console.log("total rows:", rows.length);
console.log("latest 6 (newest first):");
for (const r of rows.slice(0, 6)) {
  console.log(
    r.as_of_date,
    "close=", Math.round(r.closing_value).toLocaleString(),
    "prior=", r.prior_closing == null ? "null" : Math.round(r.prior_closing).toLocaleString(),
    "net=", Math.round(r.net_capital_flow).toLocaleString(),
    "pl=", r.nominal_pl == null ? "null" : Math.round(r.nominal_pl).toLocaleString(),
  );
}
