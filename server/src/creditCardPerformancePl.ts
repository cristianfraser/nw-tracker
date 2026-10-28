import { balanceUsdFxDateIso } from "./ccBillingBalances.js";
import { statementDatesForFacturacion } from "./ccOpenWebPastePdfReconcile.js";
import {
  isClpSection3FinancingChargeMerchant,
  isUsdSection3FinancingChargeMerchant,
} from "./ccStatementSection3.js";
import { listCcStatementLinesForStatement, listCcStatementsForAccount } from "./ccStatementsDb.js";
import { fxMonthEndForBalanceUsd } from "./fxRates.js";

/**
 * Section-3 bank charges (intereses, comisiones, impuestos) billed in one facturación, all cards
 * on the master: the lines of the statements that make up the facturación (the one rule,
 * `statementDatesForFacturacion` — a stale open bucket belongs to the open month), dollars at the
 * facturación's debt rate (pay-by − 1, `balanceUsdFxDateIso`), the frame the daily card P/L
 * (`ccFinancingCostDaily.ts`) values the same charges in.
 */
export function statementSection3ChargesClpForBillingMonth(
  accountId: number,
  billingMonth: string
): number {
  const dates = new Set(statementDatesForFacturacion(accountId, billingMonth));
  let sum = 0;
  for (const st of listCcStatementsForAccount(accountId)) {
    if (!dates.has(st.statement_date)) continue;
    let clpPerUsd: number | null = null;
    for (const line of listCcStatementLinesForStatement(st.id)) {
      if (line.installment_flag) continue;
      if (st.currency === "usd") {
        const amt = line.amount_usd ?? 0;
        if (!isUsdSection3FinancingChargeMerchant(line.merchant, amt) || amt <= 0) continue;
        if (clpPerUsd == null) {
          const fxDate = balanceUsdFxDateIso(accountId, st.statement_date);
          const fx = fxMonthEndForBalanceUsd(fxDate);
          if (!fx || !(fx.clp_per_usd > 0)) {
            throw new Error(
              `Account ${accountId}: no USD/CLP rate on or before ${fxDate} for the ${st.statement_date} financing charges`
            );
          }
          clpPerUsd = fx.clp_per_usd;
        }
        sum += Math.round(amt * clpPerUsd);
      } else {
        const amt = line.amount_clp ?? 0;
        if (!isClpSection3FinancingChargeMerchant(line.merchant) || amt <= 0) continue;
        sum += amt;
      }
    }
  }
  return Math.round(sum);
}
