import { AFP_UNO_CUOTA_SERIES_KEY } from "./afpQuetalmiApi.js";
import {
  latestAfpUnoFundUnitRowOnOrBeforeForDisplay,
  latestFundUnitRowOnOrBefore,
} from "./afpUnoValuation.js";
import { priorPeriodEndYmd } from "./accountPeriodMarks.js";
import { chileCalendarAddDays, chileCalendarTodayYmd } from "./chileDate.js";
import { db } from "./db.js";
import {
  equityCloseEod,
  equityQuoteCurrency,
  equityMarketKind,
  equitySessionYmdForTicker,
  resolveEquityQuote,
} from "./equityQuote.js";
import { fxForLiveMtm, fxRowOnOrBefore } from "./fxRates.js";
import { priorNyseSessionYmd } from "./marketHolidays.js";
import type { MarketDisplaySeriesRow } from "./marketDisplaySeries.js";
import {
  compositeLiveStats,
  compositeStatsAnchors,
  loadCompositeHoldings,
  loadCompositeMeta,
  RISKY_NORRIS_PROXY_BUCKET,
} from "./watchlistComposite.js";

export type WatchlistChanges = {
  day_pct: number | null;
  week_pct: number | null;
  mtd_pct: number | null;
  mom_pct: number | null;
  ytd_pct: number | null;
  yoy_pct: number | null;
};

export type WatchlistRowStats = {
  value: number | null;
  value_currency: "usd" | "clp";
  as_of_date: string | null;
  changes: WatchlistChanges | null;
};

function percentChange(live: number, prior: number | null | undefined): number | null {
  if (prior == null || !Number.isFinite(prior) || prior === 0 || !Number.isFinite(live)) return null;
  return ((live - prior) / prior) * 100;
}

function yoyAnchorYmd(todayYmd: string): string {
  const y = Number(todayYmd.slice(0, 4));
  return `${y - 1}${todayYmd.slice(4)}`;
}

/** Same calendar day one month earlier (UTC date arithmetic; clamps e.g. Mar 31 → Feb 28/29). */
function calendarMonthsPriorYmd(ymd: string, months: number): string {
  const y = Number(ymd.slice(0, 4));
  const m = Number(ymd.slice(5, 7));
  const d = Number(ymd.slice(8, 10));
  if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(d)) {
    throw new Error(`Invalid YMD: ${ymd}`);
  }
  const dt = new Date(Date.UTC(y, m - 1 - months, d));
  return dt.toISOString().slice(0, 10);
}

function nyseSessionsBack(fromYmd: string, sessions: number): string | null {
  let cur = fromYmd;
  for (let i = 0; i < sessions; i++) {
    const prior = priorNyseSessionYmd(cur);
    if (prior == null) return null;
    cur = prior;
  }
  return cur;
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
const stmtFundUnitOnOrBefore = db.prepare(
  `SELECT day, unit_value_clp FROM fund_unit_daily
   WHERE series_key = ? AND day <= ? ORDER BY day DESC LIMIT 1`
);

function changesFromAnchors(
  current: number,
  anchors: {
    day?: number | null;
    week?: number | null;
    mtd?: number | null;
    mom?: number | null;
    ytd?: number | null;
    yoy?: number | null;
  },
  dayPct: number | null
): WatchlistChanges {
  return {
    day_pct: dayPct,
    week_pct: anchors.week != null ? percentChange(current, anchors.week) : null,
    mtd_pct: anchors.mtd != null ? percentChange(current, anchors.mtd) : null,
    mom_pct: anchors.mom != null ? percentChange(current, anchors.mom) : null,
    ytd_pct: anchors.ytd != null ? percentChange(current, anchors.ytd) : null,
    yoy_pct: anchors.yoy != null ? percentChange(current, anchors.yoy) : null,
  };
}

function ufValueOnOrBefore(ymd: string): number | null {
  const row = stmtUfValueOnOrBefore.get(ymd) as { clp_per_uf: number } | undefined;
  if (row == null || !Number.isFinite(row.clp_per_uf)) return null;
  return row.clp_per_uf;
}

function fxValueOnOrBefore(ymd: string, now: Date): number | null {
  const today = chileCalendarTodayYmd();
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

function fundUnitValueOnOrBefore(seriesKey: string, ymd: string): number | null {
  if (seriesKey === AFP_UNO_CUOTA_SERIES_KEY) {
    const row = latestAfpUnoFundUnitRowOnOrBeforeForDisplay(seriesKey, ymd);
    return row != null && Number.isFinite(row.unit_value_clp) ? row.unit_value_clp : null;
  }
  const row = latestFundUnitRowOnOrBefore(seriesKey, ymd);
  return row != null && Number.isFinite(row.unit_value_clp) ? row.unit_value_clp : null;
}

function statsForEquity(row: MarketDisplaySeriesRow, today: string, now: Date): WatchlistRowStats {
  const ticker = row.series_key!.trim().toUpperCase();
  const sessionYmd = equitySessionYmdForTicker(ticker, now);
  const q = resolveEquityQuote(ticker, sessionYmd, { preferLive: true, now });
  const valueCurrency = equityQuoteCurrency(ticker);
  if (q == null || !Number.isFinite(q.price) || q.price <= 0) {
    return { value: null, value_currency: valueCurrency, as_of_date: null, changes: null };
  }

  const asOf = q.trade_date;
  const mtdAnchor = priorPeriodEndYmd("mtd", today);
  const ytdAnchor = priorPeriodEndYmd("ytd", today);
  const yoyAnchor = yoyAnchorYmd(today);

  const kind = equityMarketKind(ticker);
  const weekAnchorYmd =
    kind === "nyse" ? nyseSessionsBack(asOf, 5) : chileCalendarAddDays(asOf, -7);

  const momAnchor = calendarMonthsPriorYmd(asOf, 1);

  const anchors = {
    week: weekAnchorYmd != null ? equityCloseEod(ticker, weekAnchorYmd) : null,
    mtd: equityCloseEod(ticker, mtdAnchor),
    mom: equityCloseEod(ticker, momAnchor),
    ytd: equityCloseEod(ticker, ytdAnchor),
    yoy: equityCloseEod(ticker, yoyAnchor),
  };

  return {
    value: q.price,
    value_currency: valueCurrency,
    as_of_date: asOf,
    changes: changesFromAnchors(q.price, anchors, q.delta_pct),
  };
}

function statsForUf(today: string): WatchlistRowStats {
  const row = stmtUfOnOrBefore.get(today) as { date: string; clp_per_uf: number } | undefined;
  if (row == null || !Number.isFinite(row.clp_per_uf) || row.clp_per_uf <= 0) {
    return { value: null, value_currency: "clp", as_of_date: null, changes: null };
  }
  const asOf = row.date;
  const priorDay = chileCalendarAddDays(asOf, -1);
  const mtdAnchor = priorPeriodEndYmd("mtd", today);
  const ytdAnchor = priorPeriodEndYmd("ytd", today);
  const yoyAnchor = yoyAnchorYmd(today);
  const weekAnchor = chileCalendarAddDays(asOf, -7);

  const momAnchor = calendarMonthsPriorYmd(asOf, 1);

  const anchors = {
    week: ufValueOnOrBefore(weekAnchor),
    mtd: ufValueOnOrBefore(mtdAnchor),
    mom: ufValueOnOrBefore(momAnchor),
    ytd: ufValueOnOrBefore(ytdAnchor),
    yoy: ufValueOnOrBefore(yoyAnchor),
  };
  const dayPrior = ufValueOnOrBefore(priorDay);

  return {
    value: row.clp_per_uf,
    value_currency: "clp",
    as_of_date: asOf,
    changes: changesFromAnchors(row.clp_per_uf, anchors, percentChange(row.clp_per_uf, dayPrior)),
  };
}

function statsForFx(today: string, now: Date): WatchlistRowStats {
  const fxRow = fxForLiveMtm(today, now) ?? fxRowOnOrBefore(today);
  if (fxRow == null || !Number.isFinite(fxRow.clp_per_usd) || fxRow.clp_per_usd <= 0) {
    return { value: null, value_currency: "clp", as_of_date: null, changes: null };
  }
  const asOf = fxRow.date;
  const priorDay = chileCalendarAddDays(asOf, -1);
  const mtdAnchor = priorPeriodEndYmd("mtd", today);
  const ytdAnchor = priorPeriodEndYmd("ytd", today);
  const yoyAnchor = yoyAnchorYmd(today);
  const weekAnchor = chileCalendarAddDays(asOf, -7);

  const momAnchor = calendarMonthsPriorYmd(asOf, 1);

  const anchors = {
    week: fxValueOnOrBefore(weekAnchor, now),
    mtd: fxValueOnOrBefore(mtdAnchor, now),
    mom: fxValueOnOrBefore(momAnchor, now),
    ytd: fxValueOnOrBefore(ytdAnchor, now),
    yoy: fxValueOnOrBefore(yoyAnchor, now),
  };
  const dayPrior = fxValueOnOrBefore(priorDay, now);

  return {
    value: fxRow.clp_per_usd,
    value_currency: "clp",
    as_of_date: asOf,
    changes: changesFromAnchors(fxRow.clp_per_usd, anchors, percentChange(fxRow.clp_per_usd, dayPrior)),
  };
}

function statsForFundUnit(row: MarketDisplaySeriesRow, today: string): WatchlistRowStats {
  const seriesKey = row.series_key!;
  const fuRow = stmtFundUnitOnOrBefore.get(seriesKey, today) as
    | { day: string; unit_value_clp: number }
    | undefined;
  if (fuRow == null || !Number.isFinite(fuRow.unit_value_clp) || fuRow.unit_value_clp <= 0) {
    return { value: null, value_currency: "clp", as_of_date: null, changes: null };
  }
  const asOf = fuRow.day;
  const priorDay = chileCalendarAddDays(asOf, -1);
  const mtdAnchor = priorPeriodEndYmd("mtd", today);
  const ytdAnchor = priorPeriodEndYmd("ytd", today);
  const yoyAnchor = yoyAnchorYmd(today);
  const weekAnchor = chileCalendarAddDays(asOf, -7);

  const momAnchor = calendarMonthsPriorYmd(asOf, 1);

  const anchors = {
    week: fundUnitValueOnOrBefore(seriesKey, weekAnchor),
    mtd: fundUnitValueOnOrBefore(seriesKey, mtdAnchor),
    mom: fundUnitValueOnOrBefore(seriesKey, momAnchor),
    ytd: fundUnitValueOnOrBefore(seriesKey, ytdAnchor),
    yoy: fundUnitValueOnOrBefore(seriesKey, yoyAnchor),
  };
  const dayPrior = fundUnitValueOnOrBefore(seriesKey, priorDay);

  return {
    value: fuRow.unit_value_clp,
    value_currency: "clp",
    as_of_date: asOf,
    changes: changesFromAnchors(
      fuRow.unit_value_clp,
      anchors,
      percentChange(fuRow.unit_value_clp, dayPrior)
    ),
  };
}

function statsForComposite(row: MarketDisplaySeriesRow, today: string, now: Date): WatchlistRowStats {
  const bucket = row.series_key ?? RISKY_NORRIS_PROXY_BUCKET;
  const meta = loadCompositeMeta(bucket);
  const holdings = loadCompositeHoldings(bucket);
  if (meta == null || holdings.length === 0) {
    return { value: null, value_currency: "clp", as_of_date: null, changes: null };
  }
  const live = compositeLiveStats(bucket, now);
  if (live.value == null || live.as_of_date == null) {
    return { value: null, value_currency: "clp", as_of_date: null, changes: null };
  }
  const anchors = compositeStatsAnchors(meta, holdings, live.as_of_date, today, now);
  return {
    value: live.value,
    value_currency: "clp",
    as_of_date: live.as_of_date,
    changes: changesFromAnchors(live.value, anchors, live.day_pct),
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

export function watchlistStatsForRow(row: MarketDisplaySeriesRow, now = new Date()): WatchlistRowStats {
  const today = chileCalendarTodayYmd();
  if (row.kind === "uf") return statsForUf(today);
  if (row.kind === "fx_usd") return statsForFx(today, now);
  if (row.kind === "fund_unit" && row.series_key) return statsForFundUnit(row, today);
  if (row.kind === "equity" && row.series_key?.trim()) return statsForEquity(row, today, now);
  if (row.kind === "composite" && row.series_key) return statsForComposite(row, today, now);
  return { value: null, value_currency: "usd", as_of_date: null, changes: null };
}
