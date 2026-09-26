import { afterEach, describe, expect, it, vi } from "vitest";
import { computeCryptoMtmClp } from "./cryptoValuation.js";
import { db } from "./db.js";
import { LIVE_FX_SYMBOL } from "./liveMarketQuotesConfig.js";
import { insertLiveMarketQuote } from "./liveMarketQuotesDb.js";

/**
 * A crypto mark's fx is its date's frame whatever the price source. Synthetic far-future
 * fixture (no collision with seeded history): 0.5 BTC bought 2099-01-02, a 2099-01-06 (Tue)
 * bar of US$40,000 with that day's stored fx at 900, and live CLP=X at 950 during Wednesday
 * 2099-01-07's fx day (open until 17:05 New York).
 */
describe("computeCryptoMtmClp fx frame", () => {
  const TICKER = "BTC-USD";
  const TODAY = "2099-01-07";
  const UNITS = 0.5;
  let accountId: number | null = null;

  function seedFixture(liveFxFetchedAt: string): boolean {
    const leaf = db
      .prepare(`SELECT id FROM asset_groups WHERE slug LIKE '%bitcoin%' LIMIT 1`)
      .get() as { id: number } | undefined;
    if (!leaf) return false;
    accountId = Number(
      db
        .prepare(
          `INSERT INTO accounts (asset_group_id, name, notes, import_key, equity_ticker)
           VALUES (?, 'Vitest · crypto fx frame', 'vitest-crypto-fx-frame', 'vitest-crypto-fx-frame', ?)`
        )
        .run(leaf.id, TICKER).lastInsertRowid
    );
    db.prepare(
      `INSERT INTO movements (account_id, amount, currency, occurred_on, note, units_delta)
       VALUES (?, 18000000, 'clp', '2099-01-02', 'vitest-crypto-fx-frame-buy', ?)`
    ).run(accountId, UNITS);
    db.prepare(
      `INSERT INTO equity_daily (ticker, trade_date, close, currency) VALUES (?, '2099-01-06', 40000, 'usd')`
    ).run(TICKER);
    db.prepare(`INSERT INTO fx_daily (date, clp_per_usd) VALUES ('2099-01-06', 900)`).run();
    insertLiveMarketQuote({
      symbol: LIVE_FX_SYMBOL,
      kind: "fx_clp_per_usd",
      currency: null,
      value: 950,
      session_ymd: TODAY,
      previous_value: 900,
      fetched_at: liveFxFetchedAt,
    });
    return true;
  }

  afterEach(() => {
    vi.useRealTimers();
    db.prepare(`DELETE FROM live_market_quotes WHERE symbol = ? AND session_ymd >= '2099-01-01'`).run(
      LIVE_FX_SYMBOL
    );
    db.prepare(`DELETE FROM fx_daily WHERE date >= '2099-01-01'`).run();
    db.prepare(`DELETE FROM equity_daily WHERE ticker = ? AND trade_date >= '2099-01-01'`).run(TICKER);
    if (accountId != null) {
      db.prepare(`DELETE FROM movements WHERE account_id = ?`).run(accountId);
      db.prepare(`DELETE FROM accounts WHERE id = ?`).run(accountId);
    }
    accountId = null;
  });

  it("values a today mark without a live coin price at the same live fx as one with it", () => {
    if (!seedFixture("2099-01-07T14:58:00.000Z")) return;
    const now = new Date("2099-01-07T15:00:00.000Z"); // 10:00 New York: the fx day is open
    vi.useFakeTimers();
    vi.setSystemTime(now);

    const withLivePrice = computeCryptoMtmClp(accountId!, TODAY, 41_000, now);
    const eodFallback = computeCryptoMtmClp(accountId!, TODAY, null, now);
    expect(withLivePrice).toBeCloseTo(UNITS * 41_000 * 950, 2);
    // Tuesday's close at the live rate — not at Tuesday's stored fx (40,000 × 900).
    expect(eodFallback).toBeCloseTo(UNITS * 40_000 * 950, 2);
    expect(withLivePrice! / (UNITS * 41_000)).toBeCloseTo(eodFallback! / (UNITS * 40_000), 9);

    // A historical date never matches the live row's session: it keeps the stored close.
    expect(computeCryptoMtmClp(accountId!, "2099-01-06", null, now)).toBeCloseTo(
      UNITS * 40_000 * 900,
      2
    );
  });

  it("reads the day's stored close once the fx day has ended, with or without a live price", () => {
    // A fresh live row: the stored close wins because the fx day is over, not because the
    // quote went stale.
    if (!seedFixture("2099-01-07T22:29:00.000Z")) return;
    db.prepare(`INSERT INTO fx_daily (date, clp_per_usd) VALUES (?, 940)`).run(TODAY);
    const now = new Date("2099-01-07T22:30:00.000Z"); // 17:30 New York
    vi.useFakeTimers();
    vi.setSystemTime(now);

    expect(computeCryptoMtmClp(accountId!, TODAY, 41_000, now)).toBeCloseTo(UNITS * 41_000 * 940, 2);
    expect(computeCryptoMtmClp(accountId!, TODAY, null, now)).toBeCloseTo(UNITS * 40_000 * 940, 2);
  });
});
