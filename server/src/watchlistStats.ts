import { AFP_UNO_CUOTA_SERIES_KEY } from "./afpUnoSeries.js";
import {
  latestAfpUnoFundUnitRowOnOrBeforeForDisplay,
  latestFundUnitRowOnOrBefore,
} from "./afpUnoValuation.js";
import { displayDayPct, equityTickerDayCalendar, type TickerDayCalendar } from "./tickerDayDisplay.js";
import { chileCalendarAddDays, chileCalendarTodayYmd, chileWallClockAt } from "./chileDate.js";
import { db } from "./db.js";
import {
  equityCloseEod,
  equityMarketKind,
  marketQuoteCurrency,
  equitySessionYmdForTicker,
  resolveEquityQuote,
  unknownEquityMarketKind,
  type EquityMarketKind,
} from "./equityQuote.js";
import { fxForLiveMtm, fxRowOnOrBefore } from "./fxRates.js";
import { convertCurrency, pairRateOnOrBefore, type DisplayUnitCode } from "./rates.js";
import { londonSessionsBack, nyseSessionsBack } from "./marketHolidays.js";
import type { MarketDisplaySeriesRow } from "./marketDisplaySeries.js";
import {
  WATCHLIST_ANCHOR_KEYS,
  watchlistAnchorYmds,
  yoyAnchorYmd,
  type WatchlistAnchorKey,
  type WatchlistAnchorYmds,
} from "./watchlistAnchors.js";
import {
  compositeLiveStats,
  compositeValuesAtYmds,
  loadCompositeHoldings,
  loadCompositeMeta,
  RISKY_NORRIS_PROXY_BUCKET,
} from "./watchlistComposite.js";

/**
 * The unit the watchlist and the marquee are asked to express values in — the app's display
 * unit, any core currency (2026-09-21 for CLP/USD, 2026-11-11 any code). A series quoted in
 * another currency is converted LEG BY LEG through `rates.ts` at the mid: the current value at
 * the rate of its observation day (live CLP=X while that fx day is open, the stored close
 * after), each change anchor at the rate on or before the anchor's own date, and the day anchor
 * at the rate of the calendar day before the observation — the same frame the money surfaces'
 * day P/L uses, so in CLP mode a USD ticker's chip moves with price × fx and agrees with the
 * account row (VEA read +1,32% on the marquee against +0,05% in the table on 2026-09-21: the
 * peso had rallied 1,26% that day). A series already quoted in the requested unit is returned
 * untouched. The USD/CLP rate row is never converted — it IS the rate, CLP per USD in every
 * unit. The closed-day hard 0 of `displayDayPct` stays keyed on the INSTRUMENT's calendar: a
 * US-holiday fx drift still moves the money surfaces while the ticker chip reads 0
 * (documented ticker-only rule).
 */
export type WatchlistDisplayUnit = DisplayUnitCode;

export type WatchlistChanges = {
  day_pct: number | null;
  week_pct: number | null;
  mtd_pct: number | null;
  mom_pct: number | null;
  ytd_pct: number | null;
  yoy_pct: number | null;
  y3_pct: number | null;
  y5_pct: number | null;
  y10_pct: number | null;
};

export type WatchlistRowStats = {
  value: number | null;
  /**
   * Currency `value` is expressed in — the requested display unit, except the fx rate row
   * (always CLP per USD) and an index (`none`: its level is points in both units).
   */
  value_currency: string;
  as_of_date: string | null;
  changes: WatchlistChanges | null;
};

/** A series value and the calendar day whose fx converts it. */
type DatedValue = { value: number | null; ymd: string };

/** A series' stats in its own quote currency, before display-unit conversion. */
type NativeRowStats = {
  quote_currency: string;
  value: number;
  as_of_date: string;
  /** Day anchor: the prior value and the calendar day its fx leg is read at. */
  day_prior: DatedValue;
  /** Calendar for the closed-day hard 0 (`displayDayPct`); null = the real change always. */
  day_calendar: TickerDayCalendar | null;
  anchors: Record<WatchlistAnchorKey, DatedValue>;
};

function percentChange(live: number, prior: number | null | undefined): number | null {
  if (prior == null || !Number.isFinite(prior) || prior === 0 || !Number.isFinite(live)) return null;
  return ((live - prior) / prior) * 100;
}

function nullStats(unit: WatchlistDisplayUnit): WatchlistRowStats {
  return { value: null, value_currency: unit, as_of_date: null, changes: null };
}

function datedAnchors(
  ymds: WatchlistAnchorYmds,
  valueAt: (ymd: string) => number | null
): Record<WatchlistAnchorKey, DatedValue> {
  const out = {} as Record<WatchlistAnchorKey, DatedValue>;
  for (const key of WATCHLIST_ANCHOR_KEYS) {
    const ymd = ymds[key];
    out[key] = { value: ymd != null ? valueAt(ymd) : null, ymd: ymd ?? "" };
  }
  return out;
}

const stmtUfOnOrBefore = db.prepare(
  `SELECT date, clp_per_uf FROM uf_daily WHERE date <= ? ORDER BY date DESC LIMIT 1`
);
const stmtUfValueOnOrBefore = db.prepare(
  `SELECT clp_per_uf FROM uf_daily WHERE date <= ? ORDER BY date DESC LIMIT 1`
);
const stmtFxValueOnOrBefore = db.prepare(
  `SELECT clp_per_usd FROM fx_daily WHERE date <= ? ORDER BY date DESC LIMIT 1`
);

function ufValueOnOrBefore(ymd: string): number | null {
  const row = stmtUfValueOnOrBefore.get(ymd) as { clp_per_uf: number } | undefined;
  if (row == null || !Number.isFinite(row.clp_per_uf)) return null;
  return row.clp_per_uf;
}

/** CLP per USD on or before `ymd`: the live CLP=X for today while the fx day is open, else the stored close. */
function fxValueOnOrBefore(ymd: string, today: string, now: Date): number | null {
  if (ymd >= today) {
    const live = fxForLiveMtm(today, now);
    if (live != null && live.date <= ymd && Number.isFinite(live.clp_per_usd)) {
      return live.clp_per_usd;
    }
  }
  const row = stmtFxValueOnOrBefore.get(ymd) as { clp_per_usd: number } | undefined;
  if (row == null || !Number.isFinite(row.clp_per_usd)) return null;
  return row.clp_per_usd;
}

/** Latest fund-unit row on or before `ymd`; the AFP series prefers quoted rows over cert scratch rows. */
function fundUnitRowOnOrBefore(seriesKey: string, ymd: string): { day: string; unit_value: number } | null {
  const row =
    seriesKey === AFP_UNO_CUOTA_SERIES_KEY
      ? latestAfpUnoFundUnitRowOnOrBeforeForDisplay(seriesKey, ymd)
      : latestFundUnitRowOnOrBefore(seriesKey, ymd);
  return row != null && Number.isFinite(row.unit_value) ? row : null;
}

function fundUnitValueOnOrBefore(seriesKey: string, ymd: string): number | null {
  return fundUnitRowOnOrBefore(seriesKey, ymd)?.unit_value ?? null;
}

/** Converts every leg of `native` into `unit` (identity when the series is quoted in it) and takes the ratios. */
function toDisplayUnit(
  native: NativeRowStats,
  unit: WatchlistDisplayUnit,
  today: string,
  now: Date
): WatchlistRowStats {
  // An index level has no currency: the same points in both units.
  const valueCurrency = native.quote_currency === "none" ? "none" : unit;
  const convert = (dv: DatedValue): number | null => {
    if (dv.value == null || !Number.isFinite(dv.value)) return null;
    if (native.quote_currency === "none" || unit === native.quote_currency) return dv.value;
    if (dv.ymd === "") return null;
    return convertCurrency(dv.value, native.quote_currency, unit, dv.ymd, { side: "mid", now });
  };

  const value = convert({ value: native.value, ymd: native.as_of_date });
  if (value == null || value <= 0) return nullStats(unit);

  const realDayPct = percentChange(value, convert(native.day_prior));
  const pctVs = (key: WatchlistAnchorKey): number | null => percentChange(value, convert(native.anchors[key]));

  return {
    value,
    value_currency: valueCurrency,
    as_of_date: native.as_of_date,
    changes: {
      day_pct:
        native.day_calendar != null ? displayDayPct(native.day_calendar, today, realDayPct) : realDayPct,
      week_pct: pctVs("week"),
      mtd_pct: pctVs("mtd"),
      mom_pct: pctVs("mom"),
      ytd_pct: pctVs("ytd"),
      yoy_pct: pctVs("yoy"),
      y3_pct: pctVs("y3"),
      y5_pct: pctVs("y5"),
      y10_pct: pctVs("y10"),
    },
  };
}

/**
 * The 1W anchor: five sessions back on a market with a session calendar (NYSE, London), seven
 * calendar days back where the series moves on calendar days (Santiago, crypto).
 */
function weekAnchorYmd(kind: EquityMarketKind, asOf: string): string | null {
  switch (kind) {
    case "nyse":
      return nyseSessionsBack(asOf, 5);
    case "london":
      return londonSessionsBack(asOf, 5);
    case "santiago":
    case "crypto24":
      return chileCalendarAddDays(asOf, -7);
    default:
      return unknownEquityMarketKind(kind);
  }
}

function nativeForEquity(row: MarketDisplaySeriesRow, today: string, now: Date): NativeRowStats | null {
  const ticker = row.series_key!.trim().toUpperCase();
  const q = resolveEquityQuote(ticker, equitySessionYmdForTicker(ticker, now), { preferLive: true, now });
  if (q == null || !Number.isFinite(q.price) || q.price <= 0) return null;

  const asOf = q.trade_date;
  const weekYmd = weekAnchorYmd(equityMarketKind(ticker), asOf);
  return {
    quote_currency: marketQuoteCurrency(ticker),
    value: q.price,
    as_of_date: asOf,
    day_prior: { value: q.previous_close, ymd: chileCalendarAddDays(asOf, -1) },
    day_calendar: equityTickerDayCalendar(ticker),
    anchors: datedAnchors(watchlistAnchorYmds(today, asOf, weekYmd), (ymd) => equityCloseEod(ticker, ymd)),
  };
}

function nativeForUf(today: string): NativeRowStats | null {
  const row = stmtUfOnOrBefore.get(today) as { date: string; clp_per_uf: number } | undefined;
  if (row == null || !Number.isFinite(row.clp_per_uf) || row.clp_per_uf <= 0) return null;
  const asOf = row.date;
  const priorDay = chileCalendarAddDays(asOf, -1);
  return {
    quote_currency: "clp",
    value: row.clp_per_uf,
    as_of_date: asOf,
    day_prior: { value: ufValueOnOrBefore(priorDay), ymd: priorDay },
    day_calendar: null,
    anchors: datedAnchors(watchlistAnchorYmds(today, asOf, chileCalendarAddDays(asOf, -7)), ufValueOnOrBefore),
  };
}

/** The USD/CLP rate row: CLP per USD in every display unit (it is the rate, not a value). */
function statsForFx(today: string, now: Date): WatchlistRowStats {
  const fxRow = fxForLiveMtm(today, now) ?? fxRowOnOrBefore(today);
  if (fxRow == null || !Number.isFinite(fxRow.clp_per_usd) || fxRow.clp_per_usd <= 0) {
    return nullStats("clp");
  }
  const asOf = fxRow.date;
  const priorDay = chileCalendarAddDays(asOf, -1);
  const fxAt = (ymd: string) => fxValueOnOrBefore(ymd, today, now);
  const anchors = datedAnchors(watchlistAnchorYmds(today, asOf, chileCalendarAddDays(asOf, -7)), fxAt);
  const pctVs = (key: WatchlistAnchorKey) => percentChange(fxRow.clp_per_usd, anchors[key].value);

  return {
    value: fxRow.clp_per_usd,
    value_currency: "clp",
    as_of_date: asOf,
    changes: {
      day_pct: displayDayPct("weekday", today, percentChange(fxRow.clp_per_usd, fxAt(priorDay))),
      week_pct: pctVs("week"),
      mtd_pct: pctVs("mtd"),
      mom_pct: pctVs("mom"),
      ytd_pct: pctVs("ytd"),
      yoy_pct: pctVs("yoy"),
      y3_pct: pctVs("y3"),
      y5_pct: pctVs("y5"),
      y10_pct: pctVs("y10"),
    },
  };
}

/** `eur_usd` → base `eur`, quote `usd`; anything else is a broken row. */
export function fxPairCodes(seriesKey: string | null): { base: string; quote: string } {
  const m = /^([a-z]{3})_([a-z]{3})$/.exec(seriesKey ?? "");
  if (!m) throw new Error(`market_display_series: fx_pair series_key must be <base>_<quote>, got ${seriesKey}`);
  return { base: m[1]!, quote: m[2]! };
}

/**
 * A rate pair's row (EUR/USD, EUR/CLP): quote units per one base unit in every display unit, as
 * the USD/CLP row (it is the rate, not a value). Read through `rates.ts` on the pair's own rows.
 */
function statsForFxPair(row: MarketDisplaySeriesRow, today: string, now: Date): WatchlistRowStats {
  const { base, quote } = fxPairCodes(row.series_key);
  const latest = pairRateOnOrBefore(base, quote, today, now);
  if (latest == null) return nullStats(quote);
  const asOf = latest.date;
  const rateAt = (ymd: string): number | null => pairRateOnOrBefore(base, quote, ymd, now)?.mid ?? null;
  const priorDay = chileCalendarAddDays(asOf, -1);
  const anchors = datedAnchors(watchlistAnchorYmds(today, asOf, chileCalendarAddDays(asOf, -7)), rateAt);
  const pctVs = (key: WatchlistAnchorKey) => percentChange(latest.mid, anchors[key].value);
  return {
    value: latest.mid,
    value_currency: quote,
    as_of_date: asOf,
    changes: {
      day_pct: displayDayPct("weekday", today, percentChange(latest.mid, rateAt(priorDay))),
      week_pct: pctVs("week"),
      mtd_pct: pctVs("mtd"),
      mom_pct: pctVs("mom"),
      ytd_pct: pctVs("ytd"),
      yoy_pct: pctVs("yoy"),
      y3_pct: pctVs("y3"),
      y5_pct: pctVs("y5"),
      y10_pct: pctVs("y10"),
    },
  };
}

function nativeForFundUnit(row: MarketDisplaySeriesRow, today: string): NativeRowStats | null {
  const seriesKey = row.series_key!;
  const fuRow = fundUnitRowOnOrBefore(seriesKey, today);
  if (fuRow == null || fuRow.unit_value <= 0) return null;
  const asOf = fuRow.day;
  const priorDay = chileCalendarAddDays(asOf, -1);
  return {
    quote_currency: "clp",
    value: fuRow.unit_value,
    as_of_date: asOf,
    day_prior: { value: fundUnitValueOnOrBefore(seriesKey, priorDay), ymd: priorDay },
    day_calendar: "chile",
    anchors: datedAnchors(watchlistAnchorYmds(today, asOf, chileCalendarAddDays(asOf, -7)), (ymd) =>
      fundUnitValueOnOrBefore(seriesKey, ymd)
    ),
  };
}

function nativeForComposite(row: MarketDisplaySeriesRow, today: string, now: Date): NativeRowStats | null {
  const bucket = row.series_key ?? RISKY_NORRIS_PROXY_BUCKET;
  const meta = loadCompositeMeta(bucket);
  const holdings = loadCompositeHoldings(bucket);
  if (meta == null || holdings.length === 0) return null;
  const live = compositeLiveStats(bucket, now);
  if (live.value == null || live.as_of_date == null) return null;

  const asOf = live.as_of_date;
  const ymds = watchlistAnchorYmds(today, asOf, nyseSessionsBack(asOf, 5) ?? chileCalendarAddDays(asOf, -7));
  const values = compositeValuesAtYmds(meta, holdings, ymds, now);
  const anchors = {} as Record<WatchlistAnchorKey, DatedValue>;
  for (const key of WATCHLIST_ANCHOR_KEYS) anchors[key] = { value: values[key], ymd: ymds[key] ?? "" };
  // The proxy's own day change is live-vs-prior in CLP; carry the implied prior so it converts like every other leg.
  const dayPrior = live.day_pct != null ? live.value / (1 + live.day_pct / 100) : null;
  return {
    quote_currency: "clp",
    value: live.value,
    as_of_date: asOf,
    day_prior: { value: dayPrior, ymd: chileCalendarAddDays(asOf, -1) },
    day_calendar: "nyse",
    anchors,
  };
}

/**
 * UF year-over-year growth as a decimal fraction (e.g. 0.047 = 4.7%).
 * Returns null if UF data is insufficient.
 */
export function ufYoyAnnualRate(today = chileCalendarTodayYmd()): number | null {
  const current = ufValueOnOrBefore(today);
  const prior = ufValueOnOrBefore(yoyAnchorYmd(today));
  if (current == null || prior == null || prior === 0) return null;
  return (current - prior) / prior;
}

/** Value, as-of date and change columns for one watchlist/marquee row, expressed in `unit`. */
export function watchlistStatsForRow(
  row: MarketDisplaySeriesRow,
  now = new Date(),
  unit: WatchlistDisplayUnit = "clp"
): WatchlistRowStats {
  const today = chileWallClockAt(now).ymd;
  if (row.kind === "fx_usd") return statsForFx(today, now);
  if (row.kind === "fx_pair") return statsForFxPair(row, today, now);

  let native: NativeRowStats | null = null;
  if (row.kind === "uf") native = nativeForUf(today);
  else if (row.kind === "fund_unit" && row.series_key) native = nativeForFundUnit(row, today);
  else if (row.kind === "equity" && row.series_key?.trim()) native = nativeForEquity(row, today, now);
  else if (row.kind === "composite" && row.series_key) native = nativeForComposite(row, today, now);

  return native != null ? toDisplayUnit(native, unit, today, now) : nullStats(unit);
}
