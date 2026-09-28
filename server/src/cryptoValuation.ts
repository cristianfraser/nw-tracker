import {
  monthEndsBetweenInclusive,
  monthEndUtcYmd,
  monthKeyFromYmd,
} from "./calendarMonth.js";
import { accountKindSlugForAccountId } from "./accountBucket.js";
import { db } from "./db.js";
import { chileCalendarTodayYmd } from "./chileDate.js";
import {
  cryptoDisplaySessionYmd,
  equityCloseEod,
  equitySessionYmdForTicker,
  getLiveEquityQuoteFromDb,
  shouldUseLiveEquityQuote,
} from "./equityQuote.js";
import { equityTickerForAccount } from "./accountEquityTicker.js";
import { fxForLiveMtm } from "./fxRates.js";
import { transferLegUnitsThroughDate } from "./movementTransfer.js";

export type CryptoAsset = "BTC" | "ETH";

export function cryptoAssetFromCategorySlug(slug: string): CryptoAsset | null {
  if (slug === "bitcoin") return "BTC";
  if (slug === "eth") return "ETH";
  return null;
}

export function cryptoEquityTickerForCategorySlug(slug: string): "BTC-USD" | "ETH-USD" | null {
  const a = cryptoAssetFromCategorySlug(slug);
  if (a === "BTC") return "BTC-USD";
  if (a === "ETH") return "ETH-USD";
  return null;
}

function categorySlugForAccount(accountId: number): string | null {
  return accountKindSlugForAccountId(accountId);
}

export function cryptoEquityTickerForAccount(accountId: number): "BTC-USD" | "ETH-USD" | null {
  const fromCol = equityTickerForAccount(accountId);
  if (fromCol === "BTC-USD" || fromCol === "ETH-USD") return fromCol;
  const slug = categorySlugForAccount(accountId);
  return slug ? cryptoEquityTickerForCategorySlug(slug) : null;
}

const stmtHasCryptoUnits = db.prepare(
  `SELECT 1 FROM movements WHERE account_id = ? AND units_delta IS NOT NULL LIMIT 1`
);

export function accountUsesCryptoMtm(accountId: number): boolean {
  if (!cryptoEquityTickerForAccount(accountId)) return false;
  return stmtHasCryptoUnits.get(accountId) != null;
}

/**
 * Cumulative coin held through `asOfYmd`: Σ `movements.units_delta` plus signed transfer legs.
 * `units_delta` is the data; there is no note-derived fallback — a crypto account whose units
 * do not sum is bad ledger data to fix.
 */
export function cryptoCoinCumulativeThroughDate(
  accountId: number,
  asOfYmd: string,
  asset?: CryptoAsset
): number {
  if (!cryptoEquityTickerForAccount(accountId)) return 0;
  if (asset) {
    const ticker = cryptoEquityTickerForAccount(accountId);
    const expected = asset === "BTC" ? "BTC-USD" : "ETH-USD";
    if (ticker !== expected) return 0;
  }

  const row = db
    .prepare(
      `SELECT COALESCE(SUM(COALESCE(units_delta, 0)), 0) AS u
       FROM movements
       WHERE account_id = ? AND date(occurred_on) <= date(?)`
    )
    .get(accountId, asOfYmd) as { u: number };

  return (row?.u ?? 0) + transferLegUnitsThroughDate(accountId, asOfYmd);
}

/** CLP MTM: coin units through `asOfYmd` × USD price × FX. */
export function computeCryptoMtmClp(
  accountId: number,
  asOfYmd: string,
  priceUsd?: number | null,
  now: Date = new Date()
): number | null {
  const ticker = cryptoEquityTickerForAccount(accountId);
  if (!ticker) return null;
  const units = cryptoCoinCumulativeThroughDate(accountId, asOfYmd);
  if (!Number.isFinite(units) || units <= 1e-12) return 0;
  const closeUsd = priceUsd ?? equityCloseEod(ticker, asOfYmd);
  if (closeUsd == null || !Number.isFinite(closeUsd)) return null;
  // The fx is `asOfYmd`'s frame whatever the price source: live CLP=X while that date's fx day
  // is open, the stored close after it. A historical date never matches the live row's
  // session, so it reads the stored close as before. Gating the live rate on a live PRICE
  // valued a today mark with no fresh coin quote (the EOD-close fallback) at the previous
  // day's stored fx while the live-quote branch used the live rate.
  const fx = fxForLiveMtm(asOfYmd, now);
  if (!fx || fx.clp_per_usd <= 0) return null;
  const clp = units * closeUsd * fx.clp_per_usd;
  return Number.isFinite(clp) ? clp : null;
}

/**
 * {@link computeCryptoMtmClp} for a date the account must be marked on. Crypto has no other
 * value source (its stored `valuations` rows were retired 2026-09-28), so a missing coin close
 * or fx row is a data gap to fill — run the crypto EOD sync / backfill — never a stored-row
 * fallback.
 */
export function requireCryptoMtmClp(accountId: number, asOfYmd: string, now: Date = new Date()): number {
  const clp = computeCryptoMtmClp(accountId, asOfYmd, null, now);
  if (clp != null && Number.isFinite(clp)) return clp;
  const ticker = cryptoEquityTickerForAccount(accountId);
  if (!ticker) throw new Error(`account ${accountId} is not a crypto account`);
  const reason =
    equityCloseEod(ticker, asOfYmd) == null
      ? `no ${ticker} close in equity_daily on or before ${asOfYmd}`
      : `no USD/CLP fx for ${asOfYmd}`;
  throw new Error(
    `crypto account ${accountId}: cannot mark ${asOfYmd} (${reason}); crypto is valued from units × close × fx only — backfill the missing series`
  );
}

/** Cached live crypto MTM when today's UTC session allows live quotes. */
export function computeCryptoMtmClpCachedLive(
  accountId: number,
  now: Date = new Date()
): number | null {
  const ticker = cryptoEquityTickerForAccount(accountId);
  if (!ticker || !accountUsesCryptoMtm(accountId)) return null;
  const session = equitySessionYmdForTicker(ticker, now);
  if (!shouldUseLiveEquityQuote(ticker, session, now)) return null;
  const cached = getLiveEquityQuoteFromDb(ticker);
  if (!cached) return null;
  return computeCryptoMtmClp(accountId, session, cached.price, now);
}

/** Synchronous display mark: live when allowed, else last EOD for display session. */
export function computeCryptoMtmClpDisplaySync(
  accountId: number,
  now: Date = new Date()
): { value_clp: number; as_of_date: string } | null {
  const ticker = cryptoEquityTickerForAccount(accountId);
  if (!ticker || !accountUsesCryptoMtm(accountId)) return null;

  const session = equitySessionYmdForTicker(ticker, now);
  if (shouldUseLiveEquityQuote(ticker, session, now)) {
    const cached = computeCryptoMtmClpCachedLive(accountId, now);
    if (cached != null && Number.isFinite(cached)) {
      return { value_clp: cached, as_of_date: session };
    }
    const fromSession = computeCryptoMtmClp(accountId, session, null, now);
    if (fromSession != null && Number.isFinite(fromSession)) {
      return { value_clp: fromSession, as_of_date: session };
    }
  }

  const displayYmd = cryptoDisplaySessionYmd(ticker, now);
  const fromDisplay = computeCryptoMtmClp(accountId, displayYmd, null, now);
  if (fromDisplay != null && Number.isFinite(fromDisplay)) {
    return { value_clp: fromDisplay, as_of_date: displayYmd };
  }

  const mdRow = db
    .prepare(`SELECT max(trade_date) AS md FROM equity_daily WHERE ticker = ?`)
    .get(ticker) as { md: string | null } | undefined;
  const md = mdRow?.md;
  if (!md) return null;
  const c = computeCryptoMtmClp(accountId, md, null, now);
  if (c == null || !Number.isFinite(c)) return null;
  return { value_clp: c, as_of_date: md };
}

/**
 * Chart grid for one crypto account: the month-end of every month with a movement, every
 * month-end the coin's `equity_daily` series covers, and Chile today. The coin trades every
 * day, so the series' last bar is today or yesterday and its month's end is usually ahead of
 * today — that one future date (the current month-end) is the grid convention every MTM kind
 * shares (`expandSnapshotDatesForEquityMtm`, and `sanitizeValuationChartDateStrs` keeps it);
 * nothing later is ever emitted. Stored `valuations` rows play no part: crypto is marked from
 * units × close × fx only, and no crypto account carries stored rows any more.
 */
function snapshotDatesForCryptoAccount(accountId: number, equityTicker: "BTC-USD" | "ETH-USD"): string[] {
  const today = chileCalendarTodayYmd();
  const currentMonthEnd = monthEndUtcYmd(monthKeyFromYmd(today));
  const s = new Set<string>();
  const movDates = db
    .prepare(
      `SELECT occurred_on AS d FROM movements WHERE account_id = ? ORDER BY occurred_on`
    )
    .all(accountId) as { d: string }[];
  for (const r of movDates) {
    s.add(monthEndUtcYmd(monthKeyFromYmd(r.d)));
  }
  const bounds = db
    .prepare(`SELECT min(trade_date) AS a, max(trade_date) AS b FROM equity_daily WHERE ticker = ?`)
    .get(equityTicker) as { a: string | null; b: string | null } | undefined;
  if (bounds?.a && bounds?.b) {
    for (const me of monthEndsBetweenInclusive(bounds.a, bounds.b)) s.add(me);
  }
  s.add(today);
  return [...s]
    .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d) && (d <= today || d === currentMonthEnd))
    .sort();
}

/** Merge timeline keys with month-ends covered by `equity_daily` for crypto accounts. */
export function expandSnapshotDatesForCryptoMtm(baseDates: string[], accountIds: number[]): string[] {
  const s = new Set(baseDates);
  const seen = new Set<number>();
  for (const accountId of accountIds) {
    if (seen.has(accountId)) continue;
    seen.add(accountId);
    if (!accountUsesCryptoMtm(accountId)) continue;
    const ticker = cryptoEquityTickerForAccount(accountId);
    if (!ticker) continue;
    for (const d of snapshotDatesForCryptoAccount(accountId, ticker)) s.add(d);
  }
  return [...s].sort();
}
