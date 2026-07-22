/**
 * Acceptance check for the CC financing-P/L model: per billing month, the flow-derived P/L
 * (Σ of the daily series' `pl` over the month's transaction dates) must equal the negative of
 * the statement's section-3 charges — the same number the financing chart shows.
 *
 * Run: npx tsx scripts/verify-cc-financing-identity.ts [accountId ...]
 */
import { billingMonthForPurchaseDate, loadCreditCardBillingConfig } from "../src/ccBillingMonth.js";
import { ccFinancingCostClpByDate } from "../src/ccFinancingCostDaily.js";
import { listCreditCardMasterAccountIds } from "../src/creditCardTree.js";
import { statementSection3ChargesClpForBillingMonth } from "../src/ccStatementSection3.js";

const argIds = process.argv.slice(2).map(Number).filter((n) => Number.isFinite(n) && n > 0);
const accountIds = argIds.length ? argIds : listCreditCardMasterAccountIds();

let worst = 0;
for (const accountId of accountIds) {
  const cfg = loadCreditCardBillingConfig(accountId);
  const byMonth = new Map<string, number>();
  for (const [iso, clp] of ccFinancingCostClpByDate(accountId)) {
    const bm = billingMonthForPurchaseDate(iso, cfg);
    if (!bm) continue;
    byMonth.set(bm, (byMonth.get(bm) ?? 0) + clp);
  }
  // Charges are dated on the day the bank charged them, so a charge posted on the cycle end
  // can sit in the next billing month; compare the totals (does the P/L capture the same set
  // of charges?) and flag months that do not reconcile even against their neighbour.
  const months = [...new Set([...byMonth.keys()].sort())];
  let derivedTotal = 0;
  let metricTotal = 0;
  const spanMonths = new Set(months);
  for (const bm of months) {
    spanMonths.add(shiftMonth(bm, -1));
    spanMonths.add(shiftMonth(bm, 1));
  }
  for (const bm of spanMonths) {
    derivedTotal += Math.round(byMonth.get(bm) ?? 0);
    metricTotal += statementSection3ChargesClpForBillingMonth(accountId, bm);
  }
  const diff = derivedTotal - metricTotal;
  worst = Math.max(worst, Math.abs(diff));
  console.log(
    `account ${accountId}: pl total ${(-derivedTotal).toLocaleString("es-CL")}  ` +
      `metric total ${(-metricTotal).toLocaleString("es-CL")}` +
      (diff === 0 ? "  ✓" : `  DIFF ${diff.toLocaleString("es-CL")}`)
  );
}
console.log(`\nworst |total diff| = ${worst.toLocaleString("es-CL")} CLP`);

function shiftMonth(bm: string, delta: number): string {
  const [y, m] = bm.split("-").map(Number) as [number, number];
  const d = new Date(Date.UTC(y, m - 1 + delta, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}
