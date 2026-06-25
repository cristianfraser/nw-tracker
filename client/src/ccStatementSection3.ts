import type { FlowCcExpenseLineRow } from "./types";

const CC_PAYMENT_MERCHANTS = new Set(["PAGO", "MONTO CANCELADO", "ABONO"]);

function normCcMerchant(merchant: string): string {
  return String(merchant ?? "")
    .trim()
    .toUpperCase()
    .replace(/\s+/g, " ");
}

export function isCcPaymentMerchant(merchant: string | null | undefined): boolean {
  const m = normCcMerchant(String(merchant ?? ""));
  return m.length > 0 && CC_PAYMENT_MERCHANTS.has(m);
}

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

/** Statement line counted as bank financing cost (intereses, comisiones, etc.). */
export function isCcStatementFinancingCostLine(line: FlowCcExpenseLineRow): boolean {
  if (line.installment_flag) return false;
  if (line.amount_clp <= 0) return false;

  const usd = line.amount_usd ?? 0;
  if (usd > 0 && line.amount_usd != null) {
    return isUsdSection3FinancingChargeMerchant(line.merchant, usd);
  }
  return isClpSection3FinancingChargeMerchant(line.merchant);
}
