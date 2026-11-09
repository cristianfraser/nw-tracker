import { accountProfileOptional } from "./accountProfile.js";
import {
  monthEndsBetweenInclusive,
  monthEndUtcYmd,
  monthKeyFromYmd,
} from "./calendarMonth.js";
import { accountKindSlugForAccountId } from "./accountBucket.js";
import { db } from "./db.js";
import { chileCalendarTodayYmd, chileWallClockAt } from "./chileDate.js";
import { historyTierMemo } from "./cacheRegistry.js";
import {
  equityCloseEod,
  equitySessionYmdForTicker,
} from "./equityQuote.js";
import { equityTickerForAccount } from "./accountEquityTicker.js";
import { holdingPriceAt } from "./holdingPrices.js";
import { convertValue } from "./valueConvert.js";
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

/** True when the account is valued from coin units (its profile's quantity is a coin). */
export function accountUsesCryptoMtm(accountId: number): boolean {
  return accountProfileOptional(accountId)?.quantity.kind === "coin";
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
  now?: Date
): number | null {
  // A day before Chile today reads the EOD bar and the stored fx: kept in the history tier
  // (`cacheRegistry.ts`) across live-quote ticks.
  if (priceUsd == null && now === undefined && asOfYmd < chileCalendarTodayYmd()) {
    const memo = historyTierMemo<string, number | null>("crypto_mtm_clp");
    const key = `${accountId}|${asOfYmd}`;
    let v = memo.get(key);
    if (v === undefined) {
      v = computeCryptoMtmClpUncached(accountId, asOfYmd, null, new Date());
      memo.set(key, v);
    }
    return v;
  }
  return computeCryptoMtmClpUncached(accountId, asOfYmd, priceUsd, now ?? new Date());
}

function computeCryptoMtmClpUncached(
  accountId: number,
  asOfYmd: string,
  priceUsd: number | null | undefined,
  now: Date
): number | null {
  const ticker = cryptoEquityTickerForAccount(accountId);
  if (!ticker) return null;
  const units = cryptoCoinCumulativeThroughDate(accountId, asOfYmd);
  if (!Number.isFinite(units) || units <= 1e-12) return 0;
  const closeUsd = priceUsd ?? equityCloseEod(ticker, asOfYmd);
  if (closeUsd == null || !Number.isFinite(closeUsd)) return null;
  // Coins × the dollar price, converted once at what selling them would get
  // (`valueConvert.ts`): the date's rate, live while today's fx day is open.
  return convertValue(units * closeUsd, "usd", "clp", asOfYmd, "asset", now);
}

/**
 * {@link computeCryptoMtmClp} for a date the account must be marked on. Crypto has no other
 * value source (its stored `valuations` rows were retired 2026-09-28), so a missing coin close
 * or fx row is a data gap to fill — run the crypto EOD sync / backfill — never a stored-row
 * fallback.
 */
export function requireCryptoMtmClp(accountId: number, asOfYmd: string, now?: Date): number {
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

/**
 * Today's value of a coin position in dollars: the coins held today × today's price
 * (`holdingPriceAt`: the live quote of the UTC session while fresh, else the newest close on
 * or before Chile today). No coins: 0 on the session, read from the units alone (no quote).
 * Null without a close on file (the today value throws: crypto has no other value source).
 */
export function cryptoTodayNativeValue(
  accountId: number,
  now: Date = new Date()
): { value: number; currency: "usd"; as_of_date: string } | null {
  const ticker = cryptoEquityTickerForAccount(accountId);
  if (!ticker || !accountUsesCryptoMtm(accountId)) return null;
  const today = chileWallClockAt(now).ymd;
  const units = cryptoCoinCumulativeThroughDate(accountId, today);
  if (!Number.isFinite(units) || units <= 1e-12) {
    return { value: 0, currency: "usd", as_of_date: equitySessionYmdForTicker(ticker, now) };
  }
  const px = holdingPriceAt(
    { kind: "coin", coin: ticker.replace(/-USD$/i, ""), priceTicker: ticker, quote: "usd" },
    today,
    { now }
  );
  return px ? { value: units * px.price, currency: "usd", as_of_date: px.as_of } : null;
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
