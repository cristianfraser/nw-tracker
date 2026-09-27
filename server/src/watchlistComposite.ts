import { chileCalendarTodayYmd } from "./chileDate.js";
import { db } from "./db.js";
import {
  equityCloseEod,
  equityQuoteCurrency,
  equitySessionYmdForTicker,
  resolveEquityQuote,
} from "./equityQuote.js";
import { observadoFrameFxForDay } from "./fxObservadoFrame.js";
import { priorNyseSessionYmd } from "./marketHolidays.js";
import { nyseDisplaySessionYmd } from "./nyseSession.js";

export const RISKY_NORRIS_PROXY_BUCKET = "fintual_risky_norris_proxy";

/** |APV−RN|/RN at composition anchor below this → one shared proxy cuota. */
export const APV_PROXY_NEGLIGIBLE_REL_DIFF = 0.005;

/** Risky Norris (serie A) valor cuota series, in lookup order — the proxy's anchor cuota. */
export const OFFICIAL_RISKY_NORRIS_FUND_UNIT_SERIES_KEYS: readonly string[] = [
  "fintual_risky_norris",
  "fintual_cert_risky_norris",
];

export type CompositeMeta = {
  bucket_slug: string;
  fintual_managed_fund_id: number;
  /**
   * The anchor day: the Chile business day whose published cuota `anchor_fund_unit_clp` is, so
   * the basket's price base (closes on or before it) and the fx base (its dólar observado) are the
   * session that cuota was valued with (`resolveCompositionAnchor`). Never a weekend/holiday carry
   * and never a day the cuota series lacks — that pairing left Friday's NYSE move (a Chile holiday
   * Fintual carried flat) out of the level (−41 bp) and put a day-older cuota under newer closes (−190 bp).
   */
  composition_date: string;
  anchor_fund_unit_clp: number;
  /** APV régimen valor cuota at composition_date; null when APV ≈ taxable RN. */
  anchor_apv_fund_unit_clp: number | null;
  /** Σ weight·px snapshot at composition_date — informational; valuation uses per-ticker relative prices. */
  anchor_basket_usd: number;
  /**
   * Observado-frame fx the composition sync resolved for composition_date — informational;
   * valuation re-resolves both fx legs at read time (`observadoFrameFxForDay`), so a window
   * estimate taken at sync time is superseded once the day's dólar observado is published.
   */
  anchor_fx_clp: number;
  last_sync_ymd: string;
};

/** APV régimen valor cuota series, in lookup order — the APV/RN ratio's numerator on the anchor day. */
export const OFFICIAL_APV_FUND_UNIT_SERIES_KEYS: readonly string[] = [
  "fintual_cert_apv_a",
  "fintual_cert_apv_b",
  "fintual_risky_norris_apv",
];

export type CompositeHolding = {
  ticker: string;
  weight: number;
  synced_at: string;
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

/**
 * Σ weight·price level (USD). Informational only — stored as `anchor_basket_usd` by the
 * composition sync. Its ratio between two dates is price-weighted (weights act as share
 * counts, so a US$xxx SPY at 6% weight out-votes a US$46 IAUM at 8%); day-over-day
 * valuation goes through {@link basketReturnForHoldings} instead.
 */
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

/**
 * Value-weighted basket return factor vs the composition anchor:
 * Σ w·(px(ymd)/px(anchorYmd)) / Σ w. Fintual's weights are portfolio value fractions, so
 * each ticker moves the basket by weight × its own return, independent of share-price
 * magnitude. Anchor closes are read from equity_daily at call time (EOD on-or-before —
 * the same resolution the composition sync validated) rather than stored, so a
 * retroactive close adjustment moves both legs of each ratio together. Throws when any
 * price is missing; per-day gaps are nulled by callers via tryProxyClp.
 */
export function basketReturnForHoldings(
  holdings: CompositeHolding[],
  anchorYmd: string,
  ymd: string,
  opts: { preferLive?: boolean; now?: Date } = {}
): number {
  if (!holdings.length) {
    throw new Error(`composite basket ${ymd}: no holdings`);
  }
  const preferLive = opts.preferLive ?? false;
  const now = opts.now ?? new Date();
  let weightSum = 0;
  let factor = 0;
  for (const h of holdings) {
    const anchorPx = priceUsdForTickerOnYmd(h.ticker, anchorYmd, { preferLive: false, now });
    if (anchorPx == null) {
      throw new Error(`composite basket ${anchorYmd}: missing anchor price for ${h.ticker}`);
    }
    const px = priceUsdForTickerOnYmd(h.ticker, ymd, { preferLive, now });
    if (px == null) {
      throw new Error(`composite basket ${ymd}: missing price for ${h.ticker}`);
    }
    factor += h.weight * (px / anchorPx);
    weightSum += h.weight;
  }
  if (!Number.isFinite(factor) || factor <= 0 || weightSum <= 0) {
    throw new Error(`composite basket ${ymd}: invalid basket return ${factor}`);
  }
  return factor / weightSum;
}

/**
 * Proxy cuota at `ymd`: the anchor cuota carried by the basket's value-weighted USD return and
 * the fx ratio, BOTH legs in the dólar observado frame (`fxObservadoFrame.ts`) — the anchor
 * cuota embeds composition_date's interbank fx, so the ratio must be taken against that same
 * frame or the proxy starts one afternoon's peso move away from the official value.
 */
export function proxyClpFromMeta(
  meta: CompositeMeta,
  holdings: CompositeHolding[],
  ymd: string,
  opts: { preferLive?: boolean; now?: Date } = {}
): number {
  if (!Number.isFinite(meta.anchor_fund_unit_clp) || meta.anchor_fund_unit_clp <= 0) {
    throw new Error(`composite proxy ${ymd}: invalid anchor metadata`);
  }
  const now = opts.now ?? new Date();
  const basketReturn = basketReturnForHoldings(holdings, meta.composition_date, ymd, opts);
  const fxAnchor = observadoFrameFxForDay(meta.composition_date, now);
  const fx = observadoFrameFxForDay(ymd, now);
  return meta.anchor_fund_unit_clp * basketReturn * (fx.clp_per_usd / fxAnchor.clp_per_usd);
}

/**
 * Per-day proxy value or null when that day lacks data (holiday/gap — expected).
 * Day-independent corruption (invalid anchor metadata) still throws: swallowing it
 * would silently null every day and hide the broken composition row.
 */
function tryProxyClp(
  meta: CompositeMeta,
  holdings: CompositeHolding[],
  ymd: string,
  opts: { preferLive: boolean; now: Date }
): number | null {
  try {
    return proxyClpFromMeta(meta, holdings, ymd, opts);
  } catch (e) {
    if (e instanceof Error && e.message.includes("invalid anchor metadata")) throw e;
    return null;
  }
}

/**
 * EOD-framed proxy CLP value at each requested date (null where the day lacks data) — the
 * watchlist's change anchors; the dates themselves come from `watchlistAnchorYmds`.
 */
export function compositeValuesAtYmds<K extends string>(
  meta: CompositeMeta,
  holdings: CompositeHolding[],
  ymds: Record<K, string | null>,
  now: Date
): Record<K, number | null> {
  const out = {} as Record<K, number | null>;
  for (const key of Object.keys(ymds) as K[]) {
    const ymd = ymds[key];
    out[key] = ymd != null ? tryProxyClp(meta, holdings, ymd, { preferLive: false, now }) : null;
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
