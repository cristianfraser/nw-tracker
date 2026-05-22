import { fxMonthEndForBalanceUsd } from "./fxRates.js";

export type CcExpenseLineAmountInput = {
  installment_flag: number;
  amount_clp: number | null;
  amount_usd: number | null;
  valor_cuota_mensual_clp: number | null;
  valor_cuota_mensual_usd: number | null;
  /** When `usd`, MONTO US$ is authoritative (origin column is reference only). */
  statement_currency?: string | null;
};

function usdToClpAtDate(usd: number, fxDateIso: string | null): number | null {
  if (!Number.isFinite(usd) || usd === 0) return null;
  const fx = fxMonthEndForBalanceUsd(fxDateIso);
  if (!fx?.clp_per_usd || fx.clp_per_usd <= 0) return null;
  return Math.round(usd * fx.clp_per_usd);
}

/**
 * CLP amount for gastos / facturado: prefers CLP columns; converts USD at statement close FX
 * (same rule as {@link fxMonthEndForBalanceUsd} on billing balances).
 */
export function effectiveCcExpenseLineAmountClp(
  row: CcExpenseLineAmountInput,
  fxDateIso: string | null
): number | null {
  const isInstallment = row.installment_flag === 1;
  const cuotaClp = row.valor_cuota_mensual_clp;
  const cuotaUsd = row.valor_cuota_mensual_usd;

  const usdStatement = String(row.statement_currency ?? "").toLowerCase() === "usd";

  if (isInstallment) {
    if (usdStatement) {
      const fromUsdCuota = usdToClpAtDate(cuotaUsd ?? NaN, fxDateIso);
      if (fromUsdCuota != null) return fromUsdCuota;
    }
    if (cuotaClp != null && Number.isFinite(cuotaClp) && cuotaClp !== 0) {
      return Math.round(cuotaClp);
    }
    const fromUsdCuota = usdToClpAtDate(cuotaUsd ?? NaN, fxDateIso);
    if (fromUsdCuota != null) return fromUsdCuota;
    return null;
  }

  if (usdStatement) {
    const fromUsd = usdToClpAtDate(row.amount_usd ?? NaN, fxDateIso);
    if (fromUsd != null) return fromUsd;
  }
  if (row.amount_clp != null && Number.isFinite(row.amount_clp) && row.amount_clp !== 0) {
    return Math.round(row.amount_clp);
  }
  return usdToClpAtDate(row.amount_usd ?? NaN, fxDateIso);
}
