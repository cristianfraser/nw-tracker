import { fxMonthEndForBalanceUsd } from "./fxRates.js";
import { convertCurrency } from "./rates.js";
import { isHomeCurrency } from "./displayUnits.js";
import { lineHasPesoDollarView } from "./cards/lineAmountSql.js";

/**
 * One uniform CLP rate per foreign currency in place of every debt-frame rate of that currency,
 * while set: the anchor writer builds the statement frame with them to split a balance into its
 * peso part and one part per foreign currency (the balance is affine in each rate —
 * `ccStatementOwedByCurrencyByMonth` in `ccBillingViews.ts`). Synchronous scope only; never set
 * outside {@link withUniformDebtRates}.
 */
let uniformDebtRates: ReadonlyMap<string, number> | null = null;

export function withUniformDebtRates<T>(rates: ReadonlyMap<string, number>, fn: () => T): T {
  if (uniformDebtRates != null) throw new Error("withUniformDebtRates: already inside a uniform-rate pass");
  for (const [c, r] of rates) if (!(r > 0)) throw new Error(`withUniformDebtRates: bad ${c} rate ${r}`);
  uniformDebtRates = rates;
  try {
    return fn();
  } finally {
    uniformDebtRates = null;
  }
}

/** {@link withUniformDebtRates} for dollars alone. */
export function withUniformDebtUsdRate<T>(rate: number, fn: () => T): T {
  return withUniformDebtRates(new Map([["usd", rate]]), fn);
}

/** The uniform dollar rate of the pass in progress, else null. */
export function uniformDebtUsdRateInEffect(): number | null {
  return uniformDebtRates?.get("usd") ?? null;
}

/**
 * CLP per USD for valuing dollars as card debt in the statement frame: the `fx_daily` row on or
 * before `fxDateIso` (the facturación's pay-by − 1, `balanceUsdFxDateIso`), or the uniform rate of
 * a split pass. Null when no row is on file.
 */
export function debtFrameClpPerUsd(fxDateIso: string | null): number | null {
  const uniform = uniformDebtRates?.get("usd");
  if (uniform != null) return uniform;
  const fx = fxMonthEndForBalanceUsd(fxDateIso)?.clp_per_usd;
  return fx != null && fx > 0 ? fx : null;
}

/**
 * CLP per unit of `currency` for valuing it as card debt in the statement frame: dollars as
 * {@link debtFrameClpPerUsd}, any other currency at its debt-side rate on or before `fxDateIso`
 * (`rates.ts`), or the uniform rate of a split pass. Null when no rate is on file.
 */
export function debtFrameClpPerUnit(currency: string, fxDateIso: string | null): number | null {
  if (isHomeCurrency(currency)) return 1;
  if (currency === "usd") return debtFrameClpPerUsd(fxDateIso); // convention-ok: dollars keep their legacy path (fx_daily rates, US$ labels) for byte parity, docs/any-currency-plan.md C3
  const uniform = uniformDebtRates?.get(currency);
  if (uniform != null) return uniform;
  if (!fxDateIso) return null;
  const r = convertCurrency(1, currency, "clp", fxDateIso, { side: "debt" });
  return r != null && r > 0 ? r : null;
}

export type CcExpenseLineAmountInput = {
  installment_flag: number;
  amount_clp: number | null;
  amount_usd: number | null;
  valor_cuota_mensual_clp: number | null;
  valor_cuota_mensual_usd: number | null;
  /** When `usd`, MONTO US$ is authoritative (origin column is reference only). */
  statement_currency?: string | null;
  /**
   * What the line stores (migration 319), when the reader has it: a line in another currency than
   * pesos or dollars reads NULL in the four fields above, so the debt sums value it from these.
   */
  currency?: string;
  amount?: number | null;
  cuota_amount?: number | null;
};

/**
 * CLP amount of a statement line: the CLP columns, or its dollars through `usdToClp`, which the
 * caller picks by frame — debt sums convert at the facturación's pay-by − 1
 * (`balanceUsdFxDateIso`), expense lines at the rate their facturación was paid
 * (`ccFacturacionForeignRate.ts`), import dedupe at the statement date (it only compares amounts).
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
  if (row.currency != null && !lineHasPesoDollarView(row.currency)) {
    // A line in a third currency: what it bills in that currency, at its debt-frame rate.
    return cardLineAmountClpWith(
      { installment_flag: row.installment_flag, amount: row.amount ?? null, currency: row.currency, cuota_amount: row.cuota_amount ?? null },
      (amount, currency) => {
        const rate = debtFrameClpPerUnit(currency, fxDateIso);
        return rate == null ? null : Math.round(amount * rate);
      }
    );
  }
  return effectiveCcExpenseLineAmountClpWith(row, (usd) => {
    const fx = debtFrameClpPerUsd(fxDateIso);
    return fx == null ? null : Math.round(usd * fx);
  });
}

/** A statement line as its stored columns state it (migration 319). */
export type CcLineNativeInput = {
  installment_flag: number;
  amount: number | null;
  currency: string;
  cuota_amount: number | null;
};

/**
 * What a statement line bills, in its own currency: a cuota line its cuota, any other line its
 * amount; null when that is missing or zero. A line is in one currency, so this is what the legacy
 * two-slot readers ({@link effectiveCcExpenseLineAmountClpWith} / {@link effectiveCcExpenseLineAmountUsd})
 * picked for a peso or dollar line, for any currency.
 */
export function cardLineNativeAmount(row: CcLineNativeInput): { amount: number; currency: string } | null {
  const v = row.installment_flag === 1 ? row.cuota_amount : row.amount;
  if (v == null || !Number.isFinite(v) || v === 0) return null;
  return { amount: v, currency: row.currency };
}

/**
 * The pesos a statement line bills: its pesos as stored, or its foreign amount through
 * `toClp(amount, currency)` (only called with a finite, non-zero amount).
 */
export function cardLineAmountClpWith(
  row: CcLineNativeInput,
  toClp: (amount: number, currency: string) => number | null
): number | null {
  const native = cardLineNativeAmount(row);
  if (!native) return null;
  return isHomeCurrency(native.currency) ? Math.round(native.amount) : toClp(native.amount, native.currency);
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
