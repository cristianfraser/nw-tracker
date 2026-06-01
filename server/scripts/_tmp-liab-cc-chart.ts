import { listLiabilitiesTabAccountRows } from "../src/valuationTimeseries.js";
import { getGroupValuationTimeseries } from "../src/valuationTimeseries.js";

const rows = listLiabilitiesTabAccountRows("credit_card");
console.log("Tab rows:", rows);

const ts = getGroupValuationTimeseries("liabilities", "clp", "credit_card");
console.log(
  "Chart accounts:",
  ts.accounts_in_group.accounts?.map((a) => ({ id: a.account_id, name: a.name, dk: a.dataKey }))
);
console.log("Sample jun 2024 point:");
const jun = ts.accounts_in_group.points.find((p) => String(p.as_of_date).startsWith("2024-06"));
console.log(jun);
