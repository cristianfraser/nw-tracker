import { getAccountMonthlyPerformance } from "../src/accountPerformance.js";
import { latestValuationRowOnOrBeforeChileToday } from "../src/valuationLatest.js";
import { getAccountValuationTimeseries } from "../src/valuationTimeseries.js";

const id = 79;
const latest = latestValuationRowOnOrBeforeChileToday(id);
if (latest?.value_clp !== 1_323_181) {
  throw new Error(`latest value_clp expected 1323181, got ${latest?.value_clp}`);
}

const perf = getAccountMonthlyPerformance(id, "clp");
if (!perf) throw new Error("no perf payload for account 79");
const may = perf.monthly.find((r) => String(r.as_of_date).startsWith("2026-05"));
if (!may) throw new Error("no May 2026 perf row");
if (Math.abs(may.closing_value - 1_323_181) > 1) {
  throw new Error(`May closing expected 1323181, got ${may.closing_value}`);
}
if (may.nominal_pl == null || Math.abs(may.nominal_pl) > 1) {
  throw new Error(`May nominal_pl expected ~0, got ${may.nominal_pl}`);
}

const ts = getAccountValuationTimeseries(id, "clp", {});
const pts = ts?.accounts?.points ?? [];
const mayPt = pts.find((p) => String(p.as_of_date) === "2026-05-31");
const v = mayPt?.[String(id)];
if (typeof v !== "number" || Math.abs(v - 1_323_181) > 1) {
  throw new Error(`May chart point expected 1323181, got ${v}`);
}

console.log("verify-afc-may-2026 OK", { latest, may: { closing: may.closing_value, nominal_pl: may.nominal_pl } });
