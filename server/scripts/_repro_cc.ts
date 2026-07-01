import { chileCalendarTodayYmd } from "../src/chileDate.js";
import { billingDetailCacheForAccount } from "../src/ccBillingDetailCache.js";
import {
  liveCreditCardOutstandingClp,
  installmentRemainingClpByCalendarMonth,
  creditCardInstallmentPaymentsByBillingMonth,
} from "../src/ccInstallmentLedgerDb.js";

const n = (v: number | null | undefined) =>
  v == null ? "null" : Math.round(v).toLocaleString();

console.log("today =", chileCalendarTodayYmd());

for (const acct of [32, 42]) {
  console.log(`\n===== account ${acct} =====`);
  console.log("live outstanding =", n(liveCreditCardOutstandingClp(acct)));
  const rem = installmentRemainingClpByCalendarMonth(acct);
  const pay = creditCardInstallmentPaymentsByBillingMonth(acct);
  for (const m of ["2026-05", "2026-06", "2026-07", "2026-08"]) {
    console.log(`  remaining[${m}]=`, n(rem.get(m)), " pay[" + m + "]=", n(pay.get(m)));
  }
  const detail = billingDetailCacheForAccount(acct).detail;
  console.log("  billing detail (may..aug):");
  for (const r of detail
    .filter((r) => r.billing_month >= "2026-05" && r.billing_month <= "2026-08")
    .sort((a, b) => a.billing_month.localeCompare(b.billing_month))) {
    console.log(
      `   ${r.billing_month} kind=${r.as_of_kind}`,
      "fact=", n(r.total_facturado_clp),
      "cupo=", n(r.cupo_en_cuotas_clp),
      "cuotaNext=", n(r.cuota_a_pagar_next_mes_clp),
      "=> balance=", n(r.balance_total_clp)
    );
  }
}
