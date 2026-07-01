import { chileCalendarTodayYmd } from "../src/chileDate.js";
import {
  incrementalChargesClpForBillingMonth,
} from "../src/ccBillingBalances.js";
import { paymentAbonosClpForBillingMonth } from "../src/ccBillingViews.js";
import { billingMonthForStatementDate } from "../src/ccBillingMonth.js";
import { billingMonthForManualLedgerPurchase } from "../src/ccManualBillingMonth.js";
import { listCcBillingMonthBalances } from "../src/ccBillingBalances.js";

const n = (v: number | null | undefined) =>
  v == null ? "null" : Math.round(v).toLocaleString();

console.log("today =", chileCalendarTodayYmd());
console.log("billingMonthForStatementDate(today) =", billingMonthForStatementDate(chileCalendarTodayYmd()));

for (const acct of [32, 42]) {
  console.log(`\n===== account ${acct} =====`);
  console.log("billingMonthForManualLedgerPurchase =", billingMonthForManualLedgerPurchase(acct));
  for (const m of ["2026-06", "2026-07"]) {
    console.log(
      `  ${m}: incrementalCharges=`, n(incrementalChargesClpForBillingMonth(acct, m)),
      " payments=", n(paymentAbonosClpForBillingMonth(acct, m))
    );
  }
  console.log("  cc_billing_month_balances rows:");
  for (const b of listCcBillingMonthBalances(acct).filter((r: any) => r.billing_month >= "2026-05")) {
    console.log("   ", JSON.stringify(b));
  }
}
