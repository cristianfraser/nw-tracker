import { isCcPaymentMerchant } from "./ccPaymentLines.js";
import { listCcStatementLinesForStatement, listCcStatementsForAccount } from "./ccStatementsDb.js";
import { fxMonthEndForBalanceUsd } from "./fxRates.js";

export const RE_CLP_SECTION3_CHARGE =
  /IMPUESTOS|INTERESES|TRASPASO|COMISION|IMPTO\.|SERVICIO\s+USO\s+INTERNACIONAL|IVA\s+USO\s+INTERNACIONAL|NOTA\s+DE\s+CREDITO|DCTO\s+COM|ADM\|MANTENCION/i;

export const RE_USD_SECTION3 =
  /IMPUESTOS|INTERESES|TRASPASO|COMISION|ABONO\s+DE\s+DIVISAS|SERVICIO|NOTA\s+DE\s+CREDITO/i;

/** USD debt rolled into CLP balance — section 3 for PDF reconcile, not financing cost. */
export function isCcTraspasoDeudaMerchant(merchant: string | null | undefined): boolean {
  const m = String(merchant ?? "").trim().toUpperCase();
  return m.includes("TRASPASO") && m.includes("DEUDA");
}

export function isClpSection3Merchant(merchant: string | null): boolean {
  const m = String(merchant ?? "").trim();
  if (isCcPaymentMerchant(m)) return false;
  return RE_CLP_SECTION3_CHARGE.test(m);
}

export function isUsdSection3Merchant(merchant: string | null, amountUsd: number): boolean {
  const m = String(merchant ?? "").trim().toUpperCase();
  if (!m) return false;
  if (isCcPaymentMerchant(m) || m.includes("ABONO DE DIVISAS")) return true;
  if (amountUsd <= 0) return true;
  return RE_USD_SECTION3.test(m);
}

export function isClpSection3FinancingChargeMerchant(merchant: string | null): boolean {
  if (isCcTraspasoDeudaMerchant(merchant)) return false;
  return isClpSection3Merchant(merchant);
}

export function isUsdSection3FinancingChargeMerchant(
  merchant: string | null,
  amountUsd: number
): boolean {
  if (isCcTraspasoDeudaMerchant(merchant)) return false;
  return isUsdSection3Merchant(merchant, amountUsd);
}

function usdToClpAtFxDate(usd: number, fxDateIso: string | null): number | null {
  if (!Number.isFinite(usd) || usd <= 0) return null;
  const fx = fxMonthEndForBalanceUsd(fxDateIso ?? "");
  if (!fx?.clp_per_usd || fx.clp_per_usd <= 0) return null;
  return Math.round(usd * fx.clp_per_usd);
}

/** Section-3 bank charges (intereses, comisiones, etc.) for one billing month, all cards on the master. */
export function statementSection3ChargesClpForBillingMonth(
  accountId: number,
  billingMonth: string
): number {
  let sum = 0;
  for (const st of listCcStatementsForAccount(accountId)) {
    if (st.billing_month !== billingMonth) continue;
    const fxDate = st.pay_by_iso ?? st.statement_date_iso;
    const isUsdStmt = st.currency === "usd";
    for (const line of listCcStatementLinesForStatement(st.id)) {
      if (line.installment_flag) continue;
      if (isUsdStmt) {
        const amt = line.amount_usd ?? 0;
        if (!isUsdSection3FinancingChargeMerchant(line.merchant, amt) || amt <= 0) continue;
        sum += usdToClpAtFxDate(amt, fxDate) ?? 0;
      } else {
        const amt = line.amount_clp ?? 0;
        if (!isClpSection3FinancingChargeMerchant(line.merchant) || amt <= 0) continue;
        sum += amt;
      }
    }
  }
  return Math.round(sum);
}
