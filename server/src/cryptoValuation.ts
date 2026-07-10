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
import { fxForLiveMtm, fxMonthEndForBalanceUsd } from "./fxRates.js";
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
  const fx =
    priceUsd != null && Number.isFinite(priceUsd)
      ? fxForLiveMtm(asOfYmd, now)
      : fxMonthEndForBalanceUsd(asOfYmd);
  if (!fx || fx.clp_per_usd <= 0) return null;
  const clp = units * closeUsd * fx.clp_per_usd;
  return Number.isFinite(clp) ? clp : null;
}

export function computeCryptoMtmClpLive(
  accountId: number,
  now: Date = new Date()
): { value_clp: number; as_of_date: string } | null {
  const ticker = cryptoEquityTickerForAccount(accountId);
  if (!ticker) return null;
  const session = equitySessionYmdForTicker(ticker, now);
  const quote = getLiveEquityQuoteFromDb(ticker);
  if (!quote) return null;
  const clp = computeCryptoMtmClp(accountId, session, quote.price, now);
  if (clp == null || !Number.isFinite(clp)) return null;
  return { value_clp: clp, as_of_date: quote.trade_date };
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

function snapshotDatesForCryptoAccount(accountId: number, equityTicker: "BTC-USD" | "ETH-USD"): string[] {
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
  const valDates = db
    .prepare(`SELECT as_of_date AS d FROM valuations WHERE account_id = ?`)
    .all(accountId) as { d: string }[];
  for (const r of valDates) s.add(r.d);
  const today = chileCalendarTodayYmd();
  s.add(today);
  return [...s].filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort();
}

const upsertVal = db.prepare(`
  INSERT INTO valuations (account_id, as_of_date, value, currency, units_snapshot)
  VALUES (@account_id, @as_of_date, @value_clp, 'clp', @units_snapshot)
  ON CONFLICT(account_id, as_of_date) DO UPDATE SET
    value = excluded.value,
    currency = excluded.currency,
    units_snapshot = excluded.units_snapshot
`);

export function applyCryptoValuationsFromCoinHoldings(opts: {
  btcAccountId?: number;
  ethAccountId?: number;
  dryRun?: boolean;
}): { btcRows: number; ethRows: number } {
  let btcRows = 0;
  let ethRows = 0;

  const applyOne = (accountId: number, asset: CryptoAsset, equityTicker: "BTC-USD" | "ETH-USD") => {
    const dates = snapshotDatesForCryptoAccount(accountId, equityTicker);
    let rows = 0;
    for (const d of dates) {
      const units = cryptoCoinCumulativeThroughDate(accountId, d, asset);
      const value = computeCryptoMtmClp(accountId, d);
      if (value == null || !Number.isFinite(value)) continue;
      if (!opts.dryRun) {
        upsertVal.run({
          account_id: accountId,
          as_of_date: d,
          value_clp: Math.round(value * 100) / 100,
          units_snapshot: units,
        });
      }
      rows += 1;
    }
    return rows;
  };

  if (opts.btcAccountId != null) {
    btcRows = applyOne(opts.btcAccountId, "BTC", "BTC-USD");
  }
  if (opts.ethAccountId != null) {
    ethRows = applyOne(opts.ethAccountId, "ETH", "ETH-USD");
  }

  return { btcRows, ethRows };
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
