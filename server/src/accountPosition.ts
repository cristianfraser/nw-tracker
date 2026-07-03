import { db } from "./db.js";
import { chileCalendarTodayYmd } from "./chileDate.js";
import { AFP_UNO_CUOTA_SERIES_KEY } from "./afpQuetalmiApi.js";
import {
  afpCuotasForMarkToMarket,
  latestAfpUnoFundUnitRowOnOrBeforeForDisplay,
  latestFundUnitRowOnOrBefore,
} from "./afpUnoValuation.js";
import {
  accountUsesCryptoMtm,
  computeCryptoMtmClp,
  cryptoCoinCumulativeThroughDate,
  cryptoEquityTickerForAccount,
  type CryptoAsset,
} from "./cryptoValuation.js";
import { fxForLiveMtm, fxRowOnOrBefore } from "./fxRates.js";
import { brokerageShareUnitsThroughDate } from "./brokerageFlowMovement.js";
import { accountUsesEquityMtm } from "./brokerageEquityMtm.js";
import { equityTickerForAccount } from "./accountEquityTicker.js";
import {
  equityCloseEod,
  equityQuoteCurrency,
  equitySessionYmdForTicker,
  getLiveEquityQuoteFromDb,
  shouldUseLiveEquityQuote,
} from "./equityQuote.js";
import { fundSeriesKeyForAccount } from "./accountFundSeriesKey.js";
import { isFintualCertV2ValuationNotes } from "./fintualFundUnitDaily.js";
import { fintualGoalUnitsFromMovementsThroughDate } from "./fintualGoalUnits.js";
import {
  fintualCertV2PreferGoalsNavDisplay,
  fintualGoalsApiNavClpForImportNotes,
} from "./fintualCertV2Reconcile.js";
import {
  isRiskyNorrisProxyMtmSeries,
  riskyNorrisProxyCuotaForMtm,
  shouldUseRiskyNorrisProxyMtm,
} from "./riskyNorrisProxyMtm.js";

/** Net coin held today (Σ `units_delta` on crypto MTM accounts). */
export function netCryptoCoinFromMovements(accountId: number, _asset: CryptoAsset): number | null {
  if (!cryptoEquityTickerForAccount(accountId)) return null;
  const units = cryptoCoinCumulativeThroughDate(accountId, chileCalendarTodayYmd());
  return Number.isFinite(units) ? units : null;
}

export type UnitsKind = "shares" | "coin";

export type AccountPositionMeta = {
  ticker: string;
  units_kind: UnitsKind;
  /** ETF shares or coin units (BTC / ETH) */
  units: number | null;
  /**
   * AFP (UNO Fondo A): when set, account summary `position` uses these for valor hoy / fecha / valor cuota
   * instead of dividing latest DB valuation by units (Σ cuotas × latest `fund_unit_daily` row).
   */
  afp_override_value_clp?: number | null;
  afp_override_value_as_of?: string | null;
  afp_override_valor_cuota_clp?: number | null;
};

function fintualCertPositionMeta(
  accountId: number,
  importNotes: string,
  displayTicker: string,
  asOfYmd: string,
  now: Date = new Date()
): AccountPositionMeta | null {
  const seriesKey = fundSeriesKeyForAccount(accountId);
  if (!seriesKey) return null;
  const cuotas = fintualGoalUnitsFromMovementsThroughDate(accountId, asOfYmd);
  const fu = latestFundUnitRowOnOrBefore(seriesKey, asOfYmd);
  let px = fu?.unit_value_clp;
  let pxDay = fu?.day;
  const today = chileCalendarTodayYmd();
  const goalsNavClp = fintualGoalsApiNavClpForImportNotes(importNotes);
  const cuotaPositionClp =
    cuotas != null && cuotas > 1e-9 && px != null && px > 0
      ? Math.round(cuotas * px * 100) / 100
      : null;
  const goalsCuotaUnreconciled = fintualCertV2PreferGoalsNavDisplay({
    goalsNavClp,
    cuotaPositionClp,
    asOfYmd,
    todayYmd: today,
  });

  if (
    asOfYmd === today &&
    !goalsCuotaUnreconciled &&
    isRiskyNorrisProxyMtmSeries(seriesKey) &&
    shouldUseRiskyNorrisProxyMtm(now)
  ) {
    const proxyPx = riskyNorrisProxyCuotaForMtm(seriesKey, now);
    px = proxyPx;
    pxDay = today;
  }
  const out: AccountPositionMeta = {
    ticker: displayTicker,
    units_kind: "shares",
    units: cuotas != null && cuotas > 1e-9 ? cuotas : null,
  };
  // Fully withdrawn (or never funded): value = Σ cuotas × valor cuota = 0. Emit an explicit 0 mark
  // so live value / net worth don't fall back to the last stored (stale) valuation snapshot.
  if (cuotas == null || cuotas <= 1e-9) {
    out.units = 0;
    out.afp_override_value_clp = 0;
    out.afp_override_value_as_of = pxDay ?? today;
    if (px != null && px > 0) out.afp_override_valor_cuota_clp = Math.round(px * 10000) / 10000;
    return out;
  }
  if (goalsCuotaUnreconciled && cuotas != null && cuotas > 1e-9 && goalsNavClp != null) {
    out.afp_override_value_clp = Math.round(goalsNavClp * 100) / 100;
    out.afp_override_value_as_of = today;
    out.afp_override_valor_cuota_clp = Math.round((goalsNavClp / cuotas) * 10000) / 10000;
    return out;
  }
  if (cuotas != null && cuotas > 1e-9 && px != null && px > 0 && pxDay) {
    out.afp_override_value_clp = Math.round(cuotas * px * 100) / 100;
    out.afp_override_value_as_of = pxDay;
  }
  if (px != null && px > 0 && pxDay) {
    out.afp_override_valor_cuota_clp = Math.round(px * 10000) / 10000;
  }
  return out;
}

/** All brokerage equities (SPY, VEA, panel tickers): live quote today in session, else `equity_daily` EOD. */
export function equityBrokeragePositionMeta(
  accountId: number,
  ticker: string,
  asOfYmd: string,
  now: Date = new Date()
): AccountPositionMeta | null {
  const units = brokerageShareUnitsThroughDate(accountId, asOfYmd);
  const out: AccountPositionMeta = {
    ticker,
    units_kind: "shares",
    units: units > 1e-12 && Number.isFinite(units) ? units : null,
  };

  const today = chileCalendarTodayYmd();
  const session = equitySessionYmdForTicker(ticker, now);
  const useLive = asOfYmd === today && shouldUseLiveEquityQuote(ticker, session, now);

  let close: number | null = null;
  let markDate = asOfYmd;

  if (useLive) {
    const live = getLiveEquityQuoteFromDb(ticker);
    if (live) {
      close = live.price;
      markDate = live.trade_date;
    }
  }

  if (close == null) {
    const closeRow = db
      .prepare(
        `SELECT trade_date, close FROM equity_daily
         WHERE ticker = ? AND trade_date <= ? ORDER BY trade_date DESC LIMIT 1`
      )
      .get(ticker, asOfYmd) as { trade_date: string; close: number } | undefined;
    close = closeRow?.close ?? equityCloseEod(ticker, asOfYmd);
    markDate = closeRow?.trade_date ?? asOfYmd;
  }

  if (close == null || !Number.isFinite(close)) return out;

  const u = out.units;
  if (u == null || u <= 1e-12) return out;

  if (equityQuoteCurrency(ticker) === "clp") {
    out.afp_override_value_clp = Math.round(u * close * 100) / 100;
    out.afp_override_value_as_of = markDate;
    out.afp_override_valor_cuota_clp = Math.round(close * 10000) / 10000;
    return out;
  }

  const fx = useLive ? fxForLiveMtm(asOfYmd, now) : fxRowOnOrBefore(markDate);
  if (!fx || fx.clp_per_usd <= 0) return out;

  const mtm = Math.round(u * close * fx.clp_per_usd * 100) / 100;
  out.afp_override_value_clp = mtm;
  out.afp_override_value_as_of = markDate;
  out.afp_override_valor_cuota_clp = Math.round(close * fx.clp_per_usd * 10000) / 10000;
  return out;
}

export function getAccountPositionMeta(
  accountId: number,
  categorySlug: string,
  opts?: {
    afpCuotasAsOfYmd?: string;
    accountNotes?: string | null;
    accountName?: string | null;
    now?: Date;
  }
): AccountPositionMeta | null {
  const now = opts?.now ?? new Date();
  const asOf =
    opts?.afpCuotasAsOfYmd && /^\d{4}-\d{2}-\d{2}$/.test(opts.afpCuotasAsOfYmd.trim())
      ? opts.afpCuotasAsOfYmd.trim()
      : chileCalendarTodayYmd();
  if (opts?.accountNotes && isFintualCertV2ValuationNotes(opts.accountNotes)) {
    const ticker = (opts.accountName ?? "Fintual").trim() || "Fintual";
    return fintualCertPositionMeta(accountId, opts.accountNotes, ticker, asOf, now);
  }

  const equityTicker = equityTickerForAccount(accountId);
  if (equityTicker && accountUsesEquityMtm(accountId)) {
    return equityBrokeragePositionMeta(accountId, equityTicker, asOf);
  }

  if (equityTicker && accountUsesCryptoMtm(accountId)) {
    const asset: CryptoAsset | null =
      equityTicker === "BTC-USD" ? "BTC" : equityTicker === "ETH-USD" ? "ETH" : null;
    if (asset) {
      const units = cryptoCoinCumulativeThroughDate(accountId, asOf, asset);
      const equityTickerRow = equityTicker;
      const mtm = computeCryptoMtmClp(accountId, asOf);
      const closeRow = db
        .prepare(
          `SELECT trade_date, close FROM equity_daily
           WHERE ticker = ? AND trade_date <= ? ORDER BY trade_date DESC LIMIT 1`
        )
        .get(equityTickerRow, asOf) as { trade_date: string; close: number } | undefined;
      const out: AccountPositionMeta = {
        ticker: asset === "BTC" ? "BTC" : "ETH",
        units_kind: "coin",
        units: units > 1e-12 && Number.isFinite(units) ? units : null,
      };
      if (mtm != null && Number.isFinite(mtm) && closeRow?.trade_date) {
        out.afp_override_value_clp = Math.round(mtm * 100) / 100;
        out.afp_override_value_as_of = closeRow.trade_date;
        const u = out.units;
        if (u != null && u > 1e-12) {
          const fx = fxRowOnOrBefore(closeRow.trade_date);
          const pxUsd = closeRow.close;
          if (fx && fx.clp_per_usd > 0 && Number.isFinite(pxUsd)) {
            out.afp_override_valor_cuota_clp = Math.round(pxUsd * fx.clp_per_usd * 10000) / 10000;
          } else {
            out.afp_override_valor_cuota_clp = Math.round((mtm / u) * 10000) / 10000;
          }
        }
      }
      return out;
    }
  }
  if (categorySlug === "afp") {
    const asOfCuotas =
      opts?.afpCuotasAsOfYmd && /^\d{4}-\d{2}-\d{2}$/.test(opts.afpCuotasAsOfYmd.trim())
        ? opts.afpCuotasAsOfYmd.trim()
        : chileCalendarTodayYmd();
    const series = AFP_UNO_CUOTA_SERIES_KEY;
    let fu = latestAfpUnoFundUnitRowOnOrBeforeForDisplay(series, asOfCuotas);
    if (fu == null) fu = latestFundUnitRowOnOrBefore(series, asOfCuotas);
    const px = fu?.unit_value_clp;
    const pxDay = fu?.day;

    const stored = db
      .prepare(
        `SELECT value_clp FROM valuations WHERE account_id = ? AND as_of_date = ?`
      )
      .get(accountId, asOfCuotas) as { value_clp: number } | undefined;

    const cuotasFromMovements = afpCuotasForMarkToMarket(accountId, asOfCuotas, px ?? undefined);
    let cuotas = cuotasFromMovements;
    if (
      stored?.value_clp != null &&
      Number.isFinite(stored.value_clp) &&
      px != null &&
      Number.isFinite(px) &&
      px > 0 &&
      Number.isFinite(cuotasFromMovements) &&
      cuotasFromMovements > 0
    ) {
      const derivedValue = Math.round(cuotasFromMovements * px * 100) / 100;
      const relDiff = Math.abs(derivedValue - stored.value_clp) / stored.value_clp;
      if (relDiff > 0.05) {
        cuotas = Math.round((stored.value_clp / px) * 1e4) / 1e4;
      }
    }

    const out: AccountPositionMeta = {
      ticker: "UNO-A",
      units_kind: "shares",
      units: cuotas > 1e-9 && Number.isFinite(cuotas) ? cuotas : null,
    };
    if (cuotas > 1e-9 && px != null && px > 0 && pxDay) {
      out.afp_override_value_clp = Math.round(cuotas * px * 100) / 100;
      out.afp_override_value_as_of = pxDay;
      out.afp_override_valor_cuota_clp = Math.round(px * 10000) / 10000;
    }
    return out;
  }
  return null;
}

/** Live AFP mark: Σ cuotas × latest valor cuota (same as dashboard / account summary). */
export function liveFintualCertDisplayValueClp(
  accountId: number,
  importNotes: string,
  accountName: string | null | undefined,
  asOfYmd?: string,
  now?: Date
): { value_clp: number; as_of_date: string } | null {
  const asOf =
    asOfYmd && /^\d{4}-\d{2}-\d{2}$/.test(asOfYmd.trim()) ? asOfYmd.trim() : chileCalendarTodayYmd();
  const meta = fintualCertPositionMeta(
    accountId,
    importNotes,
    (accountName ?? "Fintual").trim() || "Fintual",
    asOf,
    now ?? new Date()
  );
  const clp = meta?.afp_override_value_clp;
  const date = meta?.afp_override_value_as_of;
  if (clp != null && Number.isFinite(clp) && date) {
    return { value_clp: clp, as_of_date: date };
  }
  return null;
}

export function liveAfpDisplayValueClp(
  accountId: number,
  asOfYmd?: string
): { value_clp: number; as_of_date: string } | null {
  const asOf =
    asOfYmd && /^\d{4}-\d{2}-\d{2}$/.test(asOfYmd.trim()) ? asOfYmd.trim() : chileCalendarTodayYmd();
  const meta = getAccountPositionMeta(accountId, "afp", { afpCuotasAsOfYmd: asOf });
  const clp = meta?.afp_override_value_clp;
  const date = meta?.afp_override_value_as_of;
  if (clp != null && Number.isFinite(clp) && date) {
    return { value_clp: clp, as_of_date: date };
  }
  return null;
}

/** Chart / pie trailing point: live AFP when requested, else stored valuation snapshot. */
export function fintualCertValuationRawClpForChart(
  accountId: number,
  importNotes: string,
  accountName: string | null | undefined,
  asOfYmd: string,
  storedClp: number | null | undefined,
  useLiveMark: boolean
): number | null {
  const live = liveFintualCertDisplayValueClp(accountId, importNotes, accountName, asOfYmd);
  if (live && (useLiveMark || storedClp == null || !Number.isFinite(storedClp))) return live.value_clp;
  return storedClp != null && Number.isFinite(storedClp) ? storedClp : null;
}

export function afpValuationRawClpForChart(
  accountId: number,
  storedClp: number | null | undefined,
  useLiveMark: boolean
): number | null {
  if (useLiveMark) {
    const live = liveAfpDisplayValueClp(accountId);
    if (live) return live.value_clp;
  }
  return storedClp != null && Number.isFinite(storedClp) ? storedClp : null;
}

export function applyLiveAfpToAccountValueMap(
  lastVal: Map<number, number>,
  accountMeta: Map<number, { category_slug: string; notes?: string | null; name?: string | null }>
): void {
  for (const [id, m] of accountMeta) {
    if (m.category_slug === "afp") {
      const live = liveAfpDisplayValueClp(id);
      if (live) lastVal.set(id, live.value_clp);
      continue;
    }
    if (m.notes && isFintualCertV2ValuationNotes(m.notes)) {
      const live = liveFintualCertDisplayValueClp(id, m.notes, m.name ?? null);
      if (live) lastVal.set(id, live.value_clp);
    }
  }
}
