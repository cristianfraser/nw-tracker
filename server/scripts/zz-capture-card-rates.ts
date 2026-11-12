import fs from "node:fs";
import { listCreditCardMasterAccountIds } from "../src/creditCardTree.js";
import { billingDetailCacheForAccount } from "../src/ccBillingDetailCache.js";
import { usdDebtPaymentsForAccount } from "../src/ccFacturacionUsdRate.js";
import { buildFlowsExpenseLines } from "../src/flowsExpenses.js";
import { foreignOutflowPesoCostByMovement as tracer } from "../src/foreignCashCostLots.js";
import { foreignCashTaxDisposals as taxDisp } from "../src/foreignCashTaxLotEvents.js";

const out: Record<string, unknown> = {};
for (const id of listCreditCardMasterAccountIds()) {
  let pays: unknown, fact: unknown;
  try { pays = usdDebtPaymentsForAccount(id); } catch (e) { pays = String(e); }
  try { fact = billingDetailCacheForAccount(id).facturaciones; } catch (e) { fact = String(e); }
  out[id] = { pays, fact };
}
try {
  out.lines = buildFlowsExpenseLines()
    .filter((x) => x.source === "cc")
    .map((x) => [x.purchase_key, x.billing_month, x.amount_clp, x.amount_usd]);
} catch (e) {
  out.lines = String(e);
}
out.tracer = [...tracer().entries()];
for (const posture of ["oficio_2573", "oficio_2390", "none"] as const) for (const purchaseCost of ["observado", "pesos_paid"] as const) {
  try { out[`tax_${posture}_${purchaseCost}`] = taxDisp({ posture, purchaseCost }); } catch (e) { out[`tax_${posture}_${purchaseCost}`] = String(e); }
}
fs.writeFileSync(process.argv[2]!, JSON.stringify(out, null, 1));
console.log("ok");
