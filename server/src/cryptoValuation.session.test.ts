import { afterEach, describe, expect, it, vi } from "vitest";
import { clearEquityLiveQuoteCache, equitySessionYmdForTicker, shouldUseLiveEquityQuote } from "./equityQuote.js";
import { utcTodayYmd } from "./nyseSession.js";
import {
  accountUsesCryptoMtm,
  computeCryptoMtmClpCachedLive,
  computeCryptoMtmClpDisplaySync,
  cryptoEquityTickerForAccount,
} from "./cryptoValuation.js";
import { db } from "./db.js";

const cachedLive = vi.hoisted(() => ({
  quote: null as { price: number; trade_date: string; source: "live" } | null,
}));

vi.mock("./equityQuote.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./equityQuote.js")>();
  return {
    ...actual,
    getLiveEquityQuoteFromDb: () => {
      const q = cachedLive.quote;
      if (!q) return null;
      return {
        price: q.price,
        currency: "usd" as const,
        trade_date: q.trade_date,
        source: q.source,
        previous_close: null,
        delta_pct: null,
      };
    },
  };
});

afterEach(() => {
  clearEquityLiveQuoteCache();
  cachedLive.quote = null;
});

function firstCryptoMtmAccount(): { account_id: number; ticker: "BTC-USD" | "ETH-USD" } | null {
  const row = db
    .prepare(
      `SELECT a.id AS account_id, g.slug AS bucket_slug
       FROM accounts a
       JOIN asset_groups g ON g.id = a.asset_group_id
       WHERE g.slug IN ('bitcoin', 'eth')
       ORDER BY a.id
       LIMIT 20`
    )
    .all() as { account_id: number; bucket_slug: string }[];

  for (const r of row) {
    if (!accountUsesCryptoMtm(r.account_id)) continue;
    const ticker = cryptoEquityTickerForAccount(r.account_id);
    if (ticker === "BTC-USD" || ticker === "ETH-USD") {
      return { account_id: r.account_id, ticker };
    }
  }
  return null;
}

describe("computeCryptoMtmClpCachedLive", () => {
  it("allows live on current UTC day", () => {
    const acct = firstCryptoMtmAccount();
    if (!acct) return;

    const now = new Date("2026-05-19T15:00:00Z");
    const session = equitySessionYmdForTicker(acct.ticker, now);
    expect(shouldUseLiveEquityQuote(acct.ticker, session, now)).toBe(true);

    cachedLive.quote = { price: 50_000, trade_date: session, source: "live" };
    const clp = computeCryptoMtmClpCachedLive(acct.account_id, now);
    expect(clp).not.toBeNull();
    expect(clp!).toBeGreaterThan(0);
  });
});

describe("computeCryptoMtmClpDisplaySync", () => {
  it("prefers cached live over stale max EOD when live allowed", () => {
    const acct = firstCryptoMtmAccount();
    if (!acct) return;

    const now = new Date();
    const session = equitySessionYmdForTicker(acct.ticker, now);
    if (!shouldUseLiveEquityQuote(acct.ticker, session, now)) return;

    cachedLive.quote = { price: 123_456, trade_date: utcTodayYmd(now), source: "live" };
    const sync = computeCryptoMtmClpDisplaySync(acct.account_id, now);
    expect(sync).not.toBeNull();
    expect(sync!.as_of_date).toBe(session);
  });
});
