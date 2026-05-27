import "../src/db.js";
import { db } from "../src/db.js";
import {
  billMonthFromSpentOn,
  findAmountMatchCandidates,
  gastosLineByPurchaseKey,
  loadAllRejections,
  loadExistingLinks,
  loadGastosLinesForRealEstateMatching,
  loadLinkedPurchaseKeys,
  listRealEstateExpectations,
  pickAutoLinkCandidate,
  purchaseMonthForLine,
  purchaseMonthMatchesBillSlot,
} from "../src/realEstateExpenseMatching.js";

const links = loadExistingLinks();
const exps = listRealEstateExpectations();
const gastos = loadGastosLinesForRealEstateMatching();
const linkedKeys = loadLinkedPurchaseKeys();
const rej = loadAllRejections();

const rejCount = db
  .prepare(`SELECT COUNT(*) AS n FROM real_estate_expense_link_rejections`)
  .get() as { n: number };

console.log(`links: ${links.size}`);
console.log(`rejections: ${rejCount.n}`);
console.log(`expectations: ${exps.length}`);

for (const [id, link] of links) {
  const exp = exps.find((e) => e.id === id);
  if (!exp) {
    console.log(`orphan entry ${id}`);
    continue;
  }
  const line = gastosLineByPurchaseKey(link.purchase_key, gastos);
  const bill = billMonthFromSpentOn(exp.spent_on);
  const pm = line ? purchaseMonthForLine(line) : "?";
  const ok = line && purchaseMonthMatchesBillSlot(bill, pm);
  console.log(
    `${ok ? "ok" : "BAD"} #${id} ${exp.category} bill=${bill} purchase=${pm} ${link.link_source} ${line?.merchant ?? "—"}`
  );
}

let unlinked = 0;
let pickable = 0;
for (const exp of exps) {
  if (exp.amount_clp <= 0) continue;
  if (links.has(exp.id)) continue;
  unlinked++;
  const billMonth = billMonthFromSpentOn(exp.spent_on);
  const cands = findAmountMatchCandidates(
    exp,
    gastos,
    linkedKeys,
    rej.get(exp.id) ?? new Set()
  );
  const picked = pickAutoLinkCandidate(exp, cands, billMonth);
  if (picked) pickable++;
  else if (cands.length > 0) {
    console.log(
      `ambiguous #${exp.id} ${exp.category} ${billMonth} $${exp.amount_clp} candidates=${cands.length}`
    );
  }
}
console.log(`unlinked: ${unlinked}, auto-pickable: ${pickable}`);

const rejRows = db
  .prepare(
    `SELECT expense_entry_id, purchase_key FROM real_estate_expense_link_rejections ORDER BY expense_entry_id`
  )
  .all() as { expense_entry_id: number; purchase_key: string }[];
if (rejRows.length) {
  console.log("rejections:");
  for (const r of rejRows) {
    const exp = exps.find((e) => e.id === r.expense_entry_id);
    console.log(`  #${r.expense_entry_id} ${exp?.category ?? "?"} ${r.purchase_key.slice(0, 48)}`);
  }
}

for (const exp of exps.filter((e) => e.spent_on >= "2025-11-01" && e.amount_clp > 0)) {
  if (links.has(exp.id)) continue;
  const billMonth = billMonthFromSpentOn(exp.spent_on);
  const cands = findAmountMatchCandidates(
    exp,
    gastos,
    linkedKeys,
    rej.get(exp.id) ?? new Set()
  );
  if (cands.length === 0) continue;
  console.log(
    `recent unlinked #${exp.id} ${exp.account_slug} ${exp.category} ${billMonth} $${exp.amount_clp} cands=${cands.length}`
  );
}
