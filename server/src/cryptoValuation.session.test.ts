import { afterEach, describe, expect, it, vi } from "vitest";
import { clearEquityLiveQuoteCache, equitySessionYmdForTicker, shouldUseLiveEquityQuote } from "./equityQuote.js";
import { utcTodayYmd } from "./nyseSession.js";
import {
  accountUsesCryptoMtm,
  cryptoEquityTickerForAccount,
} from "./cryptoValuation.js";
import { db } from "./db.js";
import { cryptoTodayClp } from "./test/todayClpMarks.js";

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

/** A Bitcoin account holding half a coin (the Vitest person holds no crypto). */
function createCryptoAccount(): number {
  const leaf = db.prepare(`SELECT id FROM asset_groups WHERE slug LIKE '%bitcoin%' LIMIT 1`).get() as { id: number };
  const id = Number(
    db
      .prepare(
        `INSERT INTO accounts (asset_group_id, name, notes, import_key, equity_ticker)
         VALUES (?, 'Vitest · crypto session', 'vitest-crypto-session', 'vitest-crypto-session', 'BTC-USD')`
      )
      .run(leaf.id).lastInsertRowid
  );
  db.prepare(
    `INSERT INTO movements (account_id, amount, currency, occurred_on, note, units_delta)
     VALUES (?, 1000000, 'clp', '2024-01-02', 'vitest-crypto-session-buy', 0.5)`
  ).run(id);
  return id;
}

describe("cryptoTodayNativeValue", () => {
  it("prefers cached live over stale max EOD when live allowed", () => {
    const accountId = createCryptoAccount();
    try {
      expect(accountUsesCryptoMtm(accountId)).toBe(true);
      expect(cryptoEquityTickerForAccount(accountId)).toBe("BTC-USD");
      const now = new Date();
      const session = equitySessionYmdForTicker("BTC-USD", now);
      // A coin trades every day: its live quote is always in session.
      expect(shouldUseLiveEquityQuote("BTC-USD", session, now)).toBe(true);

      cachedLive.quote = { price: 123_456, trade_date: utcTodayYmd(now), source: "live" };
      const sync = cryptoTodayClp(accountId, now);
      expect(sync).not.toBeNull();
      expect(sync!.as_of_date).toBe(session);
    } finally {
      db.prepare(`DELETE FROM movements WHERE account_id = ?`).run(accountId);
      db.prepare(`DELETE FROM accounts WHERE id = ?`).run(accountId);
    }
  });
});
