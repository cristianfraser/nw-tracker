/**
 * Manual aporte/retiro on a cuota/coin account (Fintual v2, crypto, AFP): resolve valor cuota
 * for a date and reconcile the entered CLP against `cuotas × valor_cuota` (fail fast on mismatch).
 *
 * These accounts value from `units` (cuotas / coin), so a manual flow must carry both the CLP and
 * the units. The two must agree — a mismatch means the valor cuota or one of the inputs is wrong.
 */
import { accountKindSlugForAccountId } from "./accountBucket.js";
import { AFP_UNO_CUOTA_SERIES_KEY } from "./afpQuetalmiApi.js";
import { cryptoEquityTickerForAccount } from "./cryptoValuation.js";
import { equityCloseUsdEod } from "./equityQuote.js";
import { fundSeriesKeyForAccount } from "./accountFundSeriesKey.js";
import { fundUnitClpOnOrBefore } from "./fundUnitDaily.js";
import { fxMonthEndForBalanceUsd } from "./fxRates.js";

/** Reconcile |entered CLP − cuotas × valor cuota| against this fraction of the CLP amount. */
const RECONCILE_TOLERANCE_FRACTION = 0.01;

/** Valor cuota / coin price (CLP) for `accountId` on or before `ymd`, or `null` when unavailable. */
export function valorCuotaClpOnDate(accountId: number, ymd: string): number | null {
  const cryptoTicker = cryptoEquityTickerForAccount(accountId);
  if (cryptoTicker) {
    const closeUsd = equityCloseUsdEod(cryptoTicker, ymd);
    if (closeUsd == null || !Number.isFinite(closeUsd) || closeUsd <= 0) return null;
    const fx = fxMonthEndForBalanceUsd(ymd);
    if (!fx || fx.clp_per_usd <= 0) return null;
    return closeUsd * fx.clp_per_usd;
  }
  const kind = accountKindSlugForAccountId(accountId);
  const seriesKey = kind === "afp" ? AFP_UNO_CUOTA_SERIES_KEY : fundSeriesKeyForAccount(accountId);
  if (!seriesKey) return null;
  return fundUnitClpOnOrBefore(seriesKey, ymd);
}

/**
 * Throw when the entered CLP and `unitsAbs × valor_cuota` disagree beyond tolerance.
 * No-op when valor cuota is unavailable for the date (both values are user-provided; we cannot
 * prove a mismatch without a price).
 */
export function assertManualUnitsClpReconcile(opts: {
  accountId: number;
  ymd: string;
  amountClpAbs: number;
  unitsAbs: number;
}): void {
  const valor = valorCuotaClpOnDate(opts.accountId, opts.ymd);
  if (valor == null || valor <= 0) return;
  const impliedClp = opts.unitsAbs * valor;
  const tolerance = Math.max(opts.amountClpAbs * RECONCILE_TOLERANCE_FRACTION, 1);
  if (Math.abs(impliedClp - opts.amountClpAbs) > tolerance) {
    throw new Error(
      `CLP/cuotas mismatch: ${opts.unitsAbs} cuotas × valor cuota ${valor.toFixed(4)} = ${Math.round(
        impliedClp
      )} CLP, but amount_clp = ${Math.round(opts.amountClpAbs)} CLP (${opts.ymd}).`
    );
  }
}
