import { afterEach, describe, expect, it, vi } from "vitest";
import { getAccountPositionMeta } from "./accountPosition.js";
import { db } from "./db.js";
import { LIVE_FX_SYMBOL } from "./liveMarketQuotesConfig.js";
import { insertLiveMarketQuote } from "./liveMarketQuotesDb.js";

/**
 * The crypto position's per-unit price must be quoted at the rate its value uses, so units ×
 * price is the value. Synthetic far-future fixture (no collision with seeded history): 0.5
 * BTC, a stale 2099-01-06 (Tue) bar of US$40,000 whose day's stored fx is 900, no live coin
 * quote, and live CLP=X at 950 during Wednesday 2099-01-07's fx day — the value takes the
 * date's live rate, and the per-unit price used to take the bar date's 900.
 */
describe("crypto position meta — per-unit price", () => {
  const TICKER = "BTC-USD";
  const TODAY = "2099-01-07";
  const UNITS = 0.5;
  let accountId: number | null = null;

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

  it("uses the value's rate when the coin quote is older than the date", () => {
    const leaf = db
      .prepare(`SELECT id FROM asset_groups WHERE slug = 'brokerage_crypto__bitcoin' LIMIT 1`)
      .get() as { id: number } | undefined;
    if (!leaf) return;
    accountId = Number(
      db
        .prepare(
          `INSERT INTO accounts (asset_group_id, name, notes, import_key, equity_ticker)
           VALUES (?, 'Vitest · crypto unit price', 'vitest-crypto-unit-price', 'vitest-crypto-unit-price', ?)`
        )
        .run(leaf.id, TICKER).lastInsertRowid
    );
    db.prepare(
      `INSERT INTO movements (account_id, amount, currency, occurred_on, note, units_delta)
       VALUES (?, 18000000, 'clp', '2099-01-02', 'vitest-crypto-unit-price-buy', ?)`
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
      fetched_at: "2099-01-07T14:58:00.000Z",
    });
    const now = new Date("2099-01-07T15:00:00.000Z"); // 10:00 New York: the fx day is open
    vi.useFakeTimers();
    vi.setSystemTime(now);

    const meta = getAccountPositionMeta(accountId, "bitcoin", { afpCuotasAsOfYmd: TODAY, now });
    expect(meta?.units).toBe(UNITS);
    expect(meta?.afp_override_value_clp).toBeCloseTo(UNITS * 40_000 * 950, 2);
    expect(meta?.afp_override_value_as_of).toBe("2099-01-06");
    // Tuesday's close at the value's live rate — not at Tuesday's stored 900.
    expect(meta?.afp_override_valor_cuota_clp).toBeCloseTo(40_000 * 950, 4);
    expect(UNITS * meta!.afp_override_valor_cuota_clp!).toBeCloseTo(meta!.afp_override_value_clp!, 2);
  });
});
