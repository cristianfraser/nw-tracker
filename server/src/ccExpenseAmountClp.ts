import { fxMonthEndForBalanceUsd } from "./fxRates.js";

/**
 * One uniform CLP/USD rate in place of every debt-frame rate, while set: the anchor writer builds
 * the statement frame with it to split a balance into its peso and dollar parts (the balance is
 * affine in the rate — `ccStatementOwedByCurrencyByMonth` in `ccBillingViews.ts`). Synchronous
 * scope only; never set outside {@link withUniformDebtUsdRate}.
 */
let uniformDebtUsdRate: number | null = null;

export function withUniformDebtUsdRate<T>(rate: number, fn: () => T): T {
  if (uniformDebtUsdRate != null) throw new Error("withUniformDebtUsdRate: already inside a uniform-rate pass");
  if (!(rate > 0)) throw new Error(`withUniformDebtUsdRate: bad rate ${rate}`);
  uniformDebtUsdRate = rate;
  try {
    return fn();
  } finally {
    uniformDebtUsdRate = null;
  }
}

/** The uniform rate of the pass in progress, else null. */
export function uniformDebtUsdRateInEffect(): number | null {
  return uniformDebtUsdRate;
}

/**
 * CLP per USD for valuing dollars as card debt in the statement frame: the `fx_daily` row on or
 * before `fxDateIso` (the facturación's pay-by − 1, `balanceUsdFxDateIso`), or the uniform rate of
 * a split pass. Null when no row is on file.
 */
export function debtFrameClpPerUsd(fxDateIso: string | null): number | null {
  if (uniformDebtUsdRate != null) return uniformDebtUsdRate;
  const fx = fxMonthEndForBalanceUsd(fxDateIso)?.clp_per_usd;
  return fx != null && fx > 0 ? fx : null;
}

export type CcExpenseLineAmountInput = {
  installment_flag: number;
  amount_clp: number | null;
  amount_usd: number | null;
  valor_cuota_mensual_clp: number | null;
  valor_cuota_mensual_usd: number | null;
  /** When `usd`, MONTO US$ is authoritative (origin column is reference only). */
  statement_currency?: string | null;
};

/**
 * CLP amount of a statement line: the CLP columns, or its dollars through `usdToClp`, which the
 * caller picks by frame — debt sums convert at the facturación's pay-by − 1
 * (`balanceUsdFxDateIso`), expense lines at the rate their facturación was paid
 * (`ccFacturacionUsdRate.ts`), import dedupe at the statement date (it only compares amounts).
 * `usdToClp` is only called with a finite, non-zero amount.
 */
export function effectiveCcExpenseLineAmountClpWith(
  row: CcExpenseLineAmountInput,
  usdToClp: (usd: number) => number | null
): number | null {
  const convert = (usd: number | null | undefined): number | null =>
    usd == null || !Number.isFinite(usd) || usd === 0 ? null : usdToClp(usd);
  const isInstallment = row.installment_flag === 1;
  const cuotaClp = row.valor_cuota_mensual_clp;
  const cuotaUsd = row.valor_cuota_mensual_usd;

  const usdStatement = String(row.statement_currency ?? "").toLowerCase() === "usd";

  if (isInstallment) {
    if (usdStatement) {
      const fromUsdCuota = convert(cuotaUsd);
      if (fromUsdCuota != null) return fromUsdCuota;
    }
    if (cuotaClp != null && Number.isFinite(cuotaClp) && cuotaClp !== 0) {
      return Math.round(cuotaClp);
    }
    return convert(cuotaUsd);
  }

  if (usdStatement) {
    const fromUsd = convert(row.amount_usd);
    if (fromUsd != null) return fromUsd;
  }
  if (row.amount_clp != null && Number.isFinite(row.amount_clp) && row.amount_clp !== 0) {
    return Math.round(row.amount_clp);
  }
  return convert(row.amount_usd);
}

/** {@link effectiveCcExpenseLineAmountClpWith} converting dollars at the rate on or before `fxDateIso`. */
export function effectiveCcExpenseLineAmountClp(
  row: CcExpenseLineAmountInput,
  fxDateIso: string | null
): number | null {
  return effectiveCcExpenseLineAmountClpWith(row, (usd) => {
    const fx = fxMonthEndForBalanceUsd(fxDateIso);
    if (!fx?.clp_per_usd || fx.clp_per_usd <= 0) return null;
    return Math.round(usd * fx.clp_per_usd);
  });
}

/**
 * {@link effectiveCcExpenseLineAmountClp} for a statement-frame DEBT sum: dollars at
 * {@link debtFrameClpPerUsd} (the facturación's pay-by − 1, or a split pass's uniform rate). Import
 * dedupe and line matching keep {@link effectiveCcExpenseLineAmountClp}: a split pass must not
 * change which lines match.
 */
export function debtCcExpenseLineAmountClp(
  row: CcExpenseLineAmountInput,
  fxDateIso: string | null
): number | null {
  return effectiveCcExpenseLineAmountClpWith(row, (usd) => {
    const fx = debtFrameClpPerUsd(fxDateIso);
    return fx == null ? null : Math.round(usd * fx);
  });
}

/** Original USD for display when the charge is on a USD statement (or USD-only line). */
export function effectiveCcExpenseLineAmountUsd(
  row: CcExpenseLineAmountInput
): number | null {
  const isInstallment = row.installment_flag === 1;
  const usdStatement = String(row.statement_currency ?? "").toLowerCase() === "usd";

  const pick = (v: number | null | undefined): number | null => {
    if (v == null || !Number.isFinite(v) || v === 0) return null;
    return v;
  };

  if (isInstallment) {
    const cuotaUsd = pick(row.valor_cuota_mensual_usd);
    if (cuotaUsd != null) return cuotaUsd;
    if (usdStatement) return pick(row.amount_usd);
    return null;
  }

  if (usdStatement) return pick(row.amount_usd);

  const clpMissing =
    row.amount_clp == null || !Number.isFinite(row.amount_clp) || row.amount_clp === 0;
  if (clpMissing) return pick(row.amount_usd);

  return null;
}
