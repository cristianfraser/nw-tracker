import { equityAsTradedClose, equitySplitFactorAfter } from "./equitySplits.js";
import { db } from "./db.js";
import { chileCalendarTodayYmd } from "./chileDate.js";
import {
  afpCuotasCumulativeThroughDate,
  latestFundUnitRowOnOrBefore,
} from "./afpUnoValuation.js";
import { cuotaLedgerDisplayTicker } from "./cuotaLedgerAccounts.js";
import { fundUnitRowOnOrBeforeForDisplay } from "./fundUnitDaily.js";
import { accountProfile, accountProfileOptional } from "./accountProfile.js";
import {
  requireCryptoMtmClp,
  cryptoCoinCumulativeThroughDate,
  cryptoTodayNativeValue,
  type CryptoAsset,
} from "./cryptoValuation.js";
import { convertValue } from "./valueConvert.js";
import { brokerageShareUnitsThroughDate } from "./brokerageFlowMovement.js";
import {
  equityHeldSessionQuote,
  equityQuoteCurrency,
  equitySessionYmdForTicker,
  getLiveEquityQuoteFromDb,
  shouldUseLiveEquityQuote,
} from "./equityQuote.js";
import { fundSeriesKeyForAccount } from "./accountFundSeriesKey.js";
import { optionContractsThroughDate } from "./optionPosition.js";
import { holdingPriceAt } from "./holdingPrices.js";
import type { Holding } from "./accountProfile.js";
import {
  fintualGoalUnitsFromMovementsThroughDate,
  newestCuotaMovementYmdForAccount,
} from "./fintualGoalUnits.js";
import {
  fintualCertV2PreferGoalsNavDisplay,
  fintualGoalsApiNavClpForImportNotes,
  fintualGoalsApiPollYmdForState,
  fintualGoalsNavMatchesPriorPublishPosition,
} from "./fintualCertV2Reconcile.js";
import { loadGlobalSyncState } from "./globalSyncState.js";
import {
  isRiskyNorrisProxyMtmSeries,
  riskyNorrisProxyAppliesOnYmd,
  riskyNorrisProxyCuotaForMtm,
  shouldUseRiskyNorrisProxyMtm,
} from "./riskyNorrisProxyMtm.js";

export type UnitsKind = "shares" | "coin" | "contracts";

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
  let px = fu?.unit_value;
  let pxDay = fu?.day;
  const today = chileCalendarTodayYmd();
  const goalsSyncState = loadGlobalSyncState();
  const goalsNavClp = fintualGoalsApiNavClpForImportNotes(importNotes, goalsSyncState);
  const cuotaPositionClp =
    cuotas != null && cuotas > 1e-9 && px != null && px > 0
      ? Math.round(cuotas * px * 100) / 100
      : null;
  const goalsCuotaUnreconciled = fintualCertV2PreferGoalsNavDisplay({
    goalsNavClp,
    cuotaPositionClp,
    asOfYmd,
    todayYmd: today,
    lastGoalsPollYmd: fintualGoalsApiPollYmdForState(goalsSyncState),
    newestLocalCuotaFlowYmd: newestCuotaMovementYmdForAccount(accountId),
    navMatchesPriorPublishPosition: fintualGoalsNavMatchesPriorPublishPosition(
      accountId,
      importNotes,
      goalsNavClp
    ),
  });

  // Today: the live/held proxy window. A historical date: the per-date hold — a day whose
  // official bar is a holiday flat carry the catch-up cuota has not yet superseded is valued
  // through the same held proxy as today, so the day P/L inside a held block is 0.
  const proxyApplies =
    !goalsCuotaUnreconciled &&
    isRiskyNorrisProxyMtmSeries(seriesKey) &&
    (asOfYmd === today ? shouldUseRiskyNorrisProxyMtm(now) : riskyNorrisProxyAppliesOnYmd(asOfYmd));
  if (proxyApplies) {
    px = riskyNorrisProxyCuotaForMtm(seriesKey, now, asOfYmd === today ? undefined : asOfYmd);
    pxDay = asOfYmd;
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
  // No shares: no mark, whatever the price. Reading none keeps a sold-out position's row free
  // of its ticker's live quote (`cacheDependencies.ts`).
  if (out.units == null) return out;

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

  // Post-close, pre-sync: today's mark holds the session's last stored print (= the close)
  // instead of dropping to the previous bar. See `equityHeldSessionQuote`.
  if (close == null && asOfYmd === today) {
    const held = equityHeldSessionQuote(ticker, now);
    if (held) {
      close = held.price;
      markDate = held.trade_date;
    }
  }

  if (close == null) {
    const closeRow = db
      .prepare(
        `SELECT trade_date, close FROM equity_daily
         WHERE ticker = ? AND trade_date <= ? ORDER BY trade_date DESC LIMIT 1`
      )
      .get(ticker, asOfYmd) as { trade_date: string; close: number } | undefined;
    // The shares held on `asOfYmd` at that day's traded price (`equitySplits.ts`).
    close =
      closeRow != null ? closeRow.close * equitySplitFactorAfter(ticker, asOfYmd) : equityAsTradedClose(ticker, asOfYmd);
    markDate = closeRow?.trade_date ?? asOfYmd;
  }

  if (close == null || !Number.isFinite(close)) return out;

  const u = out.units;
  if (u == null) return out;

  // The shares' value in their quote currency, converted once into pesos at the date asked —
  // the value's date, not the bar's: today at today's rate (live while the fx day is open),
  // at what selling them would get (`valueConvert.ts`).
  const quote = equityQuoteCurrency(ticker);
  const mtm = convertValue(u * close, quote, "clp", asOfYmd, "asset", now);
  const perUnit = convertValue(close, quote, "clp", asOfYmd, "asset", now);
  if (mtm == null || perUnit == null) return out;
  out.afp_override_value_clp = Math.round(mtm * 100) / 100;
  out.afp_override_value_as_of = markDate;
  out.afp_override_valor_cuota_clp = Math.round(perUnit * 10000) / 10000;
  return out;
}

/**
 * An option contract account: its SIGNED contracts (a short position is negative, never hidden),
 * valued at the contract's intrinsic value × the multiplier in pesos (`holdingPriceAt` — the
 * underlying's close; it throws without one). The «price per unit» is one contract's value. No
 * contracts (closed, expired, assigned, not opened yet): an explicit 0 mark, as every ladder reads.
 */
function optionPositionMeta(
  accountId: number,
  holding: Extract<Holding, { kind: "option" }>,
  asOf: string,
  now: Date
): AccountPositionMeta {
  const contracts = optionContractsThroughDate(accountId, asOf);
  const out: AccountPositionMeta = { ticker: holding.occSymbol, units_kind: "contracts", units: contracts };
  if (!Number.isFinite(contracts) || contracts === 0) {
    out.units = 0;
    out.afp_override_value_clp = 0;
    out.afp_override_value_as_of = asOf;
    return out;
  }
  const today = chileCalendarTodayYmd();
  const px = holdingPriceAt(holding, asOf, asOf === today ? { now } : undefined);
  if (!px) throw new Error(`option ${holding.occSymbol}: no price on ${asOf}`);
  const perContractUsd = px.price * holding.multiplier;
  const mtm = convertValue(contracts * perContractUsd, px.currency, "clp", asOf, "asset", now);
  const perContractClp = convertValue(perContractUsd, px.currency, "clp", asOf, "asset", now);
  if (mtm == null || perContractClp == null) return out;
  out.afp_override_value_clp = Math.round(mtm * 100) / 100;
  out.afp_override_value_as_of = px.as_of;
  out.afp_override_valor_cuota_clp = Math.round(perContractClp * 10000) / 10000;
  return out;
}

/**
 * The account's position (units, mark, price per unit) as of `asOfYmd` (default Chile today), by
 * its profile: a Fintual goal's cuotas, share units, coins, option contracts, or a cuota ledger's
 * cuotas. Null for every other account (its value is not units × a price).
 */
export function getAccountPositionMeta(
  accountId: number,
  opts?: { asOfYmd?: string; now?: Date }
): AccountPositionMeta | null {
  const profile = accountProfileOptional(accountId);
  if (!profile) return null;
  const now = opts?.now ?? new Date();
  const asOf =
    opts?.asOfYmd && /^\d{4}-\d{2}-\d{2}$/.test(opts.asOfYmd.trim()) ? opts.asOfYmd.trim() : chileCalendarTodayYmd();
  const q = profile.quantity;
  switch (q.kind) {
    case "fintual_goal":
      return fintualCertPositionMeta(accountId, profile.importKey!, profile.name.trim() || "Fintual", asOf, now);
    case "stock":
      return equityBrokeragePositionMeta(accountId, q.ticker, asOf, now);
    case "option_contracts":
      if (profile.holding.kind !== "option") throw new Error(`account ${accountId}: option contract account holds no option`);
      return optionPositionMeta(accountId, profile.holding, asOf, now);
    case "coin":
      return coinPositionMeta(accountId, q.priceTicker, asOf, now);
    case "cuota_ledger":
      return cuotaLedgerPositionMeta(accountId, profile.kind, q.seriesKey, asOf);
    default:
      return null;
  }
}

function coinPositionMeta(accountId: number, priceTicker: string, asOf: string, now: Date): AccountPositionMeta {
  const asset: CryptoAsset = priceTicker === "BTC-USD" ? "BTC" : "ETH";
  const units = cryptoCoinCumulativeThroughDate(accountId, asOf, asset);
  const out: AccountPositionMeta = {
    ticker: asset,
    units_kind: "coin",
    units: units > 1e-12 && Number.isFinite(units) ? units : null,
  };

  // Today: the coins × today's dollar price (`cryptoTodayNativeValue`: the live quote of the
  // UTC session while fresh), converted once into pesos at today's sell rate — the same
  // figure the account's today value carries.
  const today = chileCalendarTodayYmd();
  if (asOf === today) {
    const native = cryptoTodayNativeValue(accountId, now);
    const mtm = native ? convertValue(native.value, "usd", "clp", today, "asset", now) : null;
    if (native && mtm != null && Number.isFinite(mtm)) {
      out.afp_override_value_clp = Math.round(mtm * 100) / 100;
      out.afp_override_value_as_of = native.as_of_date;
      const u = out.units;
      if (u != null && u > 1e-12) {
        out.afp_override_valor_cuota_clp = Math.round((mtm / u) * 10000) / 10000;
      }
    }
    return out;
  }

  const mtm = requireCryptoMtmClp(accountId, asOf);
  const closeRow = db
    .prepare(
      `SELECT trade_date, close FROM equity_daily
       WHERE ticker = ? AND trade_date <= ? ORDER BY trade_date DESC LIMIT 1`
    )
    .get(priceTicker, asOf) as { trade_date: string; close: number } | undefined;
  if (mtm != null && Number.isFinite(mtm) && closeRow?.trade_date) {
    out.afp_override_value_clp = Math.round(mtm * 100) / 100;
    // `asOf`, the fx frame of these pesos (the bar may be older) — see the live branch.
    out.afp_override_value_as_of = asOf;
    const u = out.units;
    // Per-unit price from the value itself — the same close at the same rate
    // (`computeCryptoMtmClp` reads the date's fx frame, live while that fx day is open), so
    // units × price is the value even when the coin quote is older than the date.
    if (u != null && u > 1e-12) {
      out.afp_override_valor_cuota_clp = Math.round((mtm / u) * 10000) / 10000;
    }
  }
  return out;
}

/**
 * AFP and AFC (Fondo CIC): Σ cuotas × the series' valor cuota on or before the date. The cuota
 * ledger IS the truth (AFP: certificate-backed, rebuilt 2026-07 from the official UNO movement
 * certs; AFC: rebuilt from its certificate and cartolas) — no stored-valuation drift substitution.
 */
function cuotaLedgerPositionMeta(accountId: number, kind: string, series: string, asOfCuotas: string): AccountPositionMeta {
  // The valor cuota in the series' currency; a fund on a dollar series (a 401(k)) shows its
  // position in pesos at the day's rate, as a dollar stock's does.
  const fu = fundUnitRowOnOrBeforeForDisplay(series, asOfCuotas);
  const px =
    fu == null
      ? undefined
      : fu.currency === "clp"
        ? fu.unit_value
        : (convertValue(fu.unit_value, fu.currency, "clp", fu.day, "asset") ?? undefined);
  const pxDay = fu?.day;

  const cuotas = afpCuotasCumulativeThroughDate(accountId, asOfCuotas);

  const out: AccountPositionMeta = {
    ticker: cuotaLedgerDisplayTicker(kind, series),
    units_kind: "shares",
    units: cuotas > 1e-9 && Number.isFinite(cuotas) ? cuotas : null,
  };
  // Fully withdrawn or switched out of (a fund account the chain left), or not funded yet:
  // Σ cuotas × valor cuota = 0. An explicit 0 mark, like the Fintual and equity branches —
  // a null would forward-fill the last value on the monthly chart and never read as sold out.
  // Dated the day it is read, never the series' last row: a fund the chain left has its
  // series ending on its sale day, and a reader that re-asks the position «as of» the mark's
  // date would land before the switch and find the sold cuotas again.
  // Only for an account modeled in cuotas (one units event anywhere in its history): an
  // AFP account valued by stored month-ends alone (demo / CI presets) keeps the stored path.
  if (!(cuotas > 1e-9) || !Number.isFinite(cuotas)) {
    if (!hasCuotaLedgerUnitsEvents(accountId)) return out;
    out.units = 0;
    out.afp_override_value_clp = 0;
    out.afp_override_value_as_of = asOfCuotas;
    if (px != null && px > 0) out.afp_override_valor_cuota_clp = Math.round(px * 10000) / 10000;
    return out;
  }
  if (px != null && px > 0 && pxDay) {
    out.afp_override_value_clp = Math.round(cuotas * px * 100) / 100;
    out.afp_override_value_as_of = pxDay;
    out.afp_override_valor_cuota_clp = Math.round(px * 10000) / 10000;
  }
  return out;
}

/** A Fintual goal's live mark: Σ cuotas × valor cuota (the dashboard / account summary figure). */
export function liveFintualCertDisplayValueClp(
  accountId: number,
  asOfYmd?: string,
  now?: Date
): { value_clp: number; as_of_date: string } | null {
  const profile = accountProfile(accountId);
  const asOf =
    asOfYmd && /^\d{4}-\d{2}-\d{2}$/.test(asOfYmd.trim()) ? asOfYmd.trim() : chileCalendarTodayYmd();
  const meta = fintualCertPositionMeta(accountId, profile.importKey ?? "", profile.name.trim() || "Fintual", asOf, now ?? new Date());
  const clp = meta?.afp_override_value_clp;
  const date = meta?.afp_override_value_as_of;
  if (clp != null && Number.isFinite(clp) && date) {
    return { value_clp: clp, as_of_date: date };
  }
  return null;
}

/** Live cuota-ledger mark (AFP UNO / AFC CIC): Σ cuotas × valor cuota on or before `asOfYmd`. */
/** Whether the account has ever carried units — a units movement or a transfer leg with units. */
export function hasCuotaLedgerUnitsEvents(accountId: number): boolean {
  const row = db
    .prepare(
      `SELECT 1 AS hit FROM movements
       WHERE units_delta IS NOT NULL AND (account_id = ? OR from_account_id = ? OR to_account_id = ?)
       LIMIT 1`
    )
    .get(accountId, accountId, accountId) as { hit: number } | undefined;
  return row != null;
}

export function liveCuotaLedgerDisplayValueClp(
  accountId: number,
  asOfYmd?: string
): { value_clp: number; as_of_date: string } | null {
  const asOf =
    asOfYmd && /^\d{4}-\d{2}-\d{2}$/.test(asOfYmd.trim()) ? asOfYmd.trim() : chileCalendarTodayYmd();
  const meta = getAccountPositionMeta(accountId, { asOfYmd: asOf });
  const clp = meta?.afp_override_value_clp;
  const date = meta?.afp_override_value_as_of;
  if (clp != null && Number.isFinite(clp) && date) {
    return { value_clp: clp, as_of_date: date };
  }
  return null;
}


/**
 * The mark a units-priced position carries (cuota ledgers, Fintual cert funds, crypto — any
 * account whose meta prices units × a market price), or null when the meta holds no mark the
 * position may stand on. A fully withdrawn position whose meta emits an explicit 0 with a date
 * marks 0 (never the stale stored row).
 */
export function positionMarkFromMeta(
  accountId: number,
  meta: AccountPositionMeta | null | undefined
): { value_clp: number; as_of_date: string | null } | null {
  if (meta == null) return null;
  const q = accountProfileOptional(accountId)?.quantity.kind;
  const afp = q === "cuota_ledger";
  const crypto = q === "coin";
  const units = meta.units;
  const ovc = meta.afp_override_value_clp;
  // A contract's mark is its value whatever the sign: a short position marks negative, an empty
  // one 0 — the «positive value» tests below are for positions that cannot be short.
  if (q === "option_contracts") {
    return ovc != null && Number.isFinite(ovc) && meta.afp_override_value_as_of != null
      ? { value_clp: ovc, as_of_date: meta.afp_override_value_as_of }
      : null;
  }
  const fundUnitMark =
    ovc != null &&
    Number.isFinite(ovc) &&
    ovc > 0 &&
    meta.afp_override_valor_cuota_clp != null &&
    Number.isFinite(meta.afp_override_valor_cuota_clp);
  const explicitZeroMark =
    ovc === 0 && meta.afp_override_value_as_of != null && (units == null || units <= 0);
  const mtmMark =
    fundUnitMark ||
    explicitZeroMark ||
    ((afp || crypto) && ovc != null && Number.isFinite(ovc) && (ovc > 0 || (crypto && ovc === 0)));
  if (!mtmMark || ovc == null) return null;
  return { value_clp: ovc, as_of_date: meta.afp_override_value_as_of ?? null };
}

/**
 * An account's position in pesos as of today — the frame the account page's and the dashboard
 * row's `position` are converted from (`accountPositionInUnit.ts`). `value_is_today` says the
 * value is the account's today value (`accountTodayValue`), so it converts as that value does;
 * otherwise it is the position's own mark, dated `value_as_of`.
 */
export type AccountPositionClpFrame = {
  ticker: string;
  units_kind: UnitsKind;
  units: number | null;
  value_clp: number | null;
  value_as_of: string | null;
  value_per_unit_clp: number | null;
  value_is_today: boolean;
};

/**
 * The position frame of the dashboard row and of the account page summary — one copy, so the
 * two cannot drift. `today` is the account's value today (`accountTodayValue`), `meta` its
 * position asked at Chile today.
 */
export function positionClpFrameFromMeta(
  accountId: number,
  meta: AccountPositionMeta | null,
  today: { value_clp: number; as_of_date: string } | null | undefined
): AccountPositionClpFrame | null {
  if (meta == null) return null;
  const qk = accountProfileOptional(accountId)?.quantity.kind;
  const afp = qk === "cuota_ledger";
  // An option's per-unit price is one contract's value, stated by its meta (a short position's
  // value ÷ its negative units would still be it, but the meta already has it).
  const option = qk === "option_contracts";
  const v = today?.value_clp;
  const units = meta.units;
  const mark = positionMarkFromMeta(accountId, meta);
  const fundUnitMark =
    mark != null &&
    mark.value_clp > 0 &&
    meta.afp_override_valor_cuota_clp != null &&
    Number.isFinite(meta.afp_override_valor_cuota_clp);
  const value_clp = mark ? mark.value_clp : v != null && Number.isFinite(v) ? v : null;
  const value_as_of = mark ? mark.as_of_date : today?.as_of_date ?? null;
  const value_per_unit_clp =
    fundUnitMark && meta.afp_override_valor_cuota_clp != null
      ? meta.afp_override_valor_cuota_clp
      : (afp || option) && meta.afp_override_valor_cuota_clp != null && Number.isFinite(meta.afp_override_valor_cuota_clp)
        ? meta.afp_override_valor_cuota_clp
        : v != null && units != null && units > 0 && Number.isFinite(v) && Number.isFinite(units)
          ? v / units
          : null;
  return {
    ticker: meta.ticker,
    units_kind: meta.units_kind,
    units,
    value_clp,
    value_as_of,
    value_per_unit_clp,
    value_is_today: value_clp != null && v != null && value_clp === v,
  };
}
