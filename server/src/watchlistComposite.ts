import { priorPeriodEndYmd } from "./accountPeriodMarks.js";
import { chileCalendarAddDays, chileCalendarTodayYmd } from "./chileDate.js";
import { db } from "./db.js";
import {
  equityCloseEod,
  equityQuoteCurrency,
  equitySessionYmdForTicker,
  resolveEquityQuote,
} from "./equityQuote.js";
import { fxForLiveMtm } from "./fxRates.js";
import { priorNyseSessionYmd } from "./marketHolidays.js";
import { nyseDisplaySessionYmd } from "./nyseSession.js";

export const RISKY_NORRIS_PROXY_BUCKET = "fintual_risky_norris_proxy";

/** |APV−RN|/RN at composition anchor below this → one shared proxy cuota. */
export const APV_PROXY_NEGLIGIBLE_REL_DIFF = 0.005;

const OFFICIAL_FUND_UNIT_SERIES_KEYS = ["fintual_risky_norris", "fintual_cert_risky_norris"] as const;

export type CompositeMeta = {
  bucket_slug: string;
  fintual_managed_fund_id: number;
  composition_date: string;
  anchor_fund_unit_clp: number;
  /** APV régimen valor cuota at composition_date; null when APV ≈ taxable RN. */
  anchor_apv_fund_unit_clp: number | null;
  anchor_basket_usd: number;
  anchor_fx_clp: number;
  last_sync_ymd: string;
};

const OFFICIAL_APV_FUND_UNIT_SERIES_KEYS = [
  "fintual_cert_apv_a",
  "fintual_cert_apv_b",
  "fintual_risky_norris_apv",
] as const;

export type CompositeHolding = {
  ticker: string;
  weight: number;
  synced_at: string;
};

export type CompositeProxyValidation = {
  composition_date: string;
  last_sync_ymd: string;
  points: { date: string; proxy_clp: number; official_clp: number; diff_pct: number }[];
  max_abs_diff_pct: number;
};

const stmtMeta = db.prepare(
  `SELECT bucket_slug, fintual_managed_fund_id, composition_date,
          anchor_fund_unit_clp, anchor_apv_fund_unit_clp, anchor_basket_usd, anchor_fx_clp, last_sync_ymd
   FROM watchlist_composite_meta WHERE bucket_slug = ?`
);

const stmtHoldings = db.prepare(
  `SELECT ticker, weight, synced_at FROM watchlist_composite_holdings
   WHERE bucket_slug = ? ORDER BY weight DESC, ticker`
);

export function officialRiskyNorrisFundUnitOnOrBefore(ymd: string): {
  series_key: string;
  unit_value_clp: number;
  day: string;
} {
  for (const seriesKey of OFFICIAL_FUND_UNIT_SERIES_KEYS) {
    const row = db
      .prepare(
        `SELECT day, unit_value_clp FROM fund_unit_daily
         WHERE series_key = ? AND day <= ? ORDER BY day DESC LIMIT 1`
      )
      .get(seriesKey, ymd) as { day: string; unit_value_clp: number } | undefined;
    if (row != null && Number.isFinite(row.unit_value_clp) && row.unit_value_clp > 0) {
      return { series_key: seriesKey, day: row.day, unit_value_clp: row.unit_value_clp };
    }
  }
  throw new Error(
    `Risky Norris proxy: no fund_unit_daily for ${OFFICIAL_FUND_UNIT_SERIES_KEYS.join(" or ")} on or before ${ymd}`
  );
}

export function officialApvFundUnitOnOrBefore(ymd: string): {
  series_key: string;
  unit_value_clp: number;
  day: string;
} | null {
  for (const seriesKey of OFFICIAL_APV_FUND_UNIT_SERIES_KEYS) {
    const row = db
      .prepare(
        `SELECT day, unit_value_clp FROM fund_unit_daily
         WHERE series_key = ? AND day <= ? ORDER BY day DESC LIMIT 1`
      )
      .get(seriesKey, ymd) as { day: string; unit_value_clp: number } | undefined;
    if (row != null && Number.isFinite(row.unit_value_clp) && row.unit_value_clp > 0) {
      return { series_key: seriesKey, day: row.day, unit_value_clp: row.unit_value_clp };
    }
  }
  return null;
}

const stmtFxOnOrBefore = db.prepare(
  `SELECT clp_per_usd FROM fx_daily WHERE date <= ? ORDER BY date DESC LIMIT 1`
);

export function loadCompositeMeta(bucketSlug: string): CompositeMeta | null {
  const row = stmtMeta.get(bucketSlug) as CompositeMeta | undefined;
  return row ?? null;
}

export function loadCompositeHoldings(bucketSlug: string): CompositeHolding[] {
  return stmtHoldings.all(bucketSlug) as CompositeHolding[];
}

export function listCompositeConstituentTickers(bucketSlug = RISKY_NORRIS_PROXY_BUCKET): string[] {
  const rows = loadCompositeHoldings(bucketSlug);
  return [...new Set(rows.map((r) => r.ticker.trim().toUpperCase()).filter(Boolean))];
}

function fxClpOnOrBefore(ymd: string, now: Date): number | null {
  const today = chileCalendarTodayYmd();
  if (ymd >= today) {
    const live = fxForLiveMtm(today, now);
    if (live != null && live.date <= ymd && Number.isFinite(live.clp_per_usd) && live.clp_per_usd > 0) {
      return live.clp_per_usd;
    }
  }
  const row = stmtFxOnOrBefore.get(ymd) as { clp_per_usd: number } | undefined;
  if (row == null || !Number.isFinite(row.clp_per_usd) || row.clp_per_usd <= 0) return null;
  return row.clp_per_usd;
}

function priceUsdForTickerOnYmd(
  ticker: string,
  ymd: string,
  opts: { preferLive: boolean; now: Date }
): number | null {
  if (equityQuoteCurrency(ticker) !== "usd") {
    throw new Error(
      `watchlist composite: ticker ${ticker} is not USD-quoted — composites are USD baskets`
    );
  }
  if (opts.preferLive) {
    const sessionYmd = equitySessionYmdForTicker(ticker, opts.now);
    if (sessionYmd === ymd || ymd >= chileCalendarTodayYmd()) {
      const q = resolveEquityQuote(ticker, sessionYmd, { preferLive: true, now: opts.now });
      if (q != null && Number.isFinite(q.price) && q.price > 0) return q.price;
    }
  }
  const close = equityCloseEod(ticker, ymd);
  if (close != null && Number.isFinite(close) && close > 0) return close;
  return null;
}

/** Weighted USD basket for holdings on a given date. Throws if any ticker price is missing. */
export function basketUsdForHoldings(
  holdings: CompositeHolding[],
  ymd: string,
  opts: { preferLive?: boolean; now?: Date } = {}
): number {
  if (!holdings.length) {
    throw new Error(`composite basket ${ymd}: no holdings`);
  }
  const preferLive = opts.preferLive ?? false;
  const now = opts.now ?? new Date();
  let total = 0;
  for (const h of holdings) {
    const px = priceUsdForTickerOnYmd(h.ticker, ymd, { preferLive, now });
    if (px == null) {
      throw new Error(`composite basket ${ymd}: missing price for ${h.ticker}`);
    }
    total += h.weight * px;
  }
  if (!Number.isFinite(total) || total <= 0) {
    throw new Error(`composite basket ${ymd}: invalid basket total ${total}`);
  }
  return total;
}

export function proxyClpFromMeta(
  meta: CompositeMeta,
  holdings: CompositeHolding[],
  ymd: string,
  opts: { preferLive?: boolean; now?: Date } = {}
): number {
  const basketUsd = basketUsdForHoldings(holdings, ymd, opts);
  const fx = fxClpOnOrBefore(ymd, opts.now ?? new Date());
  if (fx == null) {
    throw new Error(`composite proxy ${ymd}: missing FX`);
  }
  if (
    !Number.isFinite(meta.anchor_fund_unit_clp) ||
    meta.anchor_fund_unit_clp <= 0 ||
    !Number.isFinite(meta.anchor_basket_usd) ||
    meta.anchor_basket_usd <= 0 ||
    !Number.isFinite(meta.anchor_fx_clp) ||
    meta.anchor_fx_clp <= 0
  ) {
    throw new Error(`composite proxy ${ymd}: invalid anchor metadata`);
  }
  return (
    meta.anchor_fund_unit_clp *
    (basketUsd / meta.anchor_basket_usd) *
    (fx / meta.anchor_fx_clp)
  );
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

function calendarMonthsPriorYmd(ymd: string, months: number): string {
  const y = Number(ymd.slice(0, 4));
  const m = Number(ymd.slice(5, 7));
  const d = Number(ymd.slice(8, 10));
  const dt = new Date(Date.UTC(y, m - 1 - months, d));
  return dt.toISOString().slice(0, 10);
}

function tryProxyClp(
  meta: CompositeMeta,
  holdings: CompositeHolding[],
  ymd: string,
  opts: { preferLive: boolean; now: Date }
): number | null {
  try {
    return proxyClpFromMeta(meta, holdings, ymd, opts);
  } catch {
    return null;
  }
}

export function compositeProxyValidation(
  bucketSlug: string,
  days = 30,
  now = new Date()
): CompositeProxyValidation | null {
  const meta = loadCompositeMeta(bucketSlug);
  const holdings = loadCompositeHoldings(bucketSlug);
  if (meta == null || holdings.length === 0) return null;

  const today = chileCalendarTodayYmd();
  const points: CompositeProxyValidation["points"] = [];
  for (let back = 0; back < days; back++) {
    const ymd = chileCalendarAddDays(today, -back);
    let official_clp: number;
    try {
      official_clp = officialRiskyNorrisFundUnitOnOrBefore(ymd).unit_value_clp;
    } catch {
      continue;
    }
    const proxy = tryProxyClp(meta, holdings, ymd, { preferLive: false, now });
    if (proxy == null || !Number.isFinite(proxy) || proxy <= 0) continue;
    const diff_pct = ((proxy - official_clp) / official_clp) * 100;
    points.push({
      date: ymd,
      proxy_clp: proxy,
      official_clp,
      diff_pct,
    });
  }
  points.sort((a, b) => b.date.localeCompare(a.date));
  const max_abs_diff_pct =
    points.length > 0 ? Math.max(...points.map((p) => Math.abs(p.diff_pct))) : 0;
  return {
    composition_date: meta.composition_date,
    last_sync_ymd: meta.last_sync_ymd,
    points,
    max_abs_diff_pct,
  };
}

export type CompositeStatsAnchors = {
  day: number | null;
  week: number | null;
  mtd: number | null;
  mom: number | null;
  ytd: number | null;
  yoy: number | null;
  y3: number | null;
  y5: number | null;
  y10: number | null;
};

function yearsPriorYmd(todayYmd: string, years: number): string {
  const y = Number(todayYmd.slice(0, 4));
  return `${y - years}${todayYmd.slice(4)}`;
}

function yoyAnchorYmd(todayYmd: string): string {
  return yearsPriorYmd(todayYmd, 1);
}

export function compositeStatsAnchors(
  meta: CompositeMeta,
  holdings: CompositeHolding[],
  asOfYmd: string,
  today: string,
  now: Date
): CompositeStatsAnchors {
  const priorDay = chileCalendarAddDays(asOfYmd, -1);
  const weekAnchor = nyseSessionsBack(asOfYmd, 5) ?? chileCalendarAddDays(asOfYmd, -7);
  const mtdAnchor = priorPeriodEndYmd("mtd", today);
  const ytdAnchor = priorPeriodEndYmd("ytd", today);
  const yoyAnchor = yoyAnchorYmd(today);
  const momAnchor = calendarMonthsPriorYmd(asOfYmd, 1);

  const anchorYmds = {
    day: priorDay,
    week: weekAnchor,
    mtd: mtdAnchor,
    mom: momAnchor,
    ytd: ytdAnchor,
    yoy: yoyAnchor,
    y3: yearsPriorYmd(today, 3),
    y5: yearsPriorYmd(today, 5),
    y10: yearsPriorYmd(today, 10),
  };

  const out: CompositeStatsAnchors = {
    day: null,
    week: null,
    mtd: null,
    mom: null,
    ytd: null,
    yoy: null,
    y3: null,
    y5: null,
    y10: null,
  };
  for (const key of Object.keys(anchorYmds) as (keyof typeof anchorYmds)[]) {
    out[key] = tryProxyClp(meta, holdings, anchorYmds[key], { preferLive: false, now });
  }
  return out;
}

export function compositeLiveStats(
  bucketSlug: string,
  now = new Date()
): {
  value: number | null;
  as_of_date: string | null;
  day_pct: number | null;
} {
  const meta = loadCompositeMeta(bucketSlug);
  const holdings = loadCompositeHoldings(bucketSlug);
  if (meta == null || holdings.length === 0) {
    return { value: null, as_of_date: null, day_pct: null };
  }
  // Same session rules as plain NYSE tickers: before open the display session is the
  // just-closed one (so 1D shows that session's move, not a flat 0% against itself),
  // and live quotes only apply while the session is the current one.
  const sessionYmd = nyseDisplaySessionYmd(now);
  const live = tryProxyClp(meta, holdings, sessionYmd, { preferLive: true, now });
  if (live == null) {
    return { value: null, as_of_date: null, day_pct: null };
  }
  const priorSession = priorNyseSessionYmd(sessionYmd);
  const prior =
    priorSession != null
      ? tryProxyClp(meta, holdings, priorSession, { preferLive: false, now })
      : null;
  const day_pct =
    prior != null && prior > 0 && Number.isFinite(prior)
      ? ((live - prior) / prior) * 100
      : null;
  return { value: live, as_of_date: sessionYmd, day_pct };
}
