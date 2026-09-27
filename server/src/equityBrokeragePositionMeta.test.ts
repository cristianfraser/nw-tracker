import { afterEach, describe, expect, it, vi } from "vitest";
import { db } from "./db.js";
import { equityBrokeragePositionMeta } from "./accountPosition.js";
import { LIVE_FX_SYMBOL } from "./liveMarketQuotesConfig.js";
import { clearLiveMarketQuotesForTest, insertLiveMarketQuote } from "./liveMarketQuotesDb.js";
import { BROKERAGE_SHARE_UNITS_FLOW_KINDS } from "./brokerageFlowMovement.js";

afterEach(() => {
  clearLiveMarketQuotesForTest();
});

describe("equityBrokeragePositionMeta", () => {
  it("uses live_market_quotes for Chile today during NYSE session", () => {
    const row = db
      .prepare(
        `SELECT a.id, a.equity_ticker FROM accounts a
         WHERE a.notes = 'import:excel|key=spy' LIMIT 1`
      )
      .get() as { id: number; equity_ticker: string } | undefined;
    if (!row?.equity_ticker) return;

    const hasUnits = db
      .prepare(
        `SELECT 1 FROM movements WHERE account_id = ? AND flow_kind IN (${BROKERAGE_SHARE_UNITS_FLOW_KINDS.map(() => "?").join(", ")}) AND COALESCE(units_delta, 0) != 0 LIMIT 1`
      )
      .get(row.id, ...BROKERAGE_SHARE_UNITS_FLOW_KINDS);
    if (!hasUnits) return;

    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-19T15:00:00.000Z"));
    try {
      const fetchedAt = new Date().toISOString();
      insertLiveMarketQuote({
        symbol: "SPY",
        kind: "equity",
        currency: "usd",
        value: 600,
        session_ymd: "2026-05-19",
        previous_value: 590,
        fetched_at: fetchedAt,
      });
      insertLiveMarketQuote({
        symbol: LIVE_FX_SYMBOL,
        kind: "fx_clp_per_usd",
        currency: null,
        value: 900,
        session_ymd: "2026-05-19",
        previous_value: 895,
        fetched_at: fetchedAt,
      });

      const meta = equityBrokeragePositionMeta(row.id, "SPY", "2026-05-19", new Date("2026-05-19T15:00:00.000Z"));
      const units = meta?.units;
      if (units == null || units <= 0) return;

      expect(meta!.afp_override_valor_cuota_clp).toBeCloseTo(600 * 900, 0);
      expect(meta!.afp_override_value_clp).toBeCloseTo(units * 600 * 900, -2);
    } finally {
      vi.useRealTimers();
    }
  });
});

/**
 * Synthetic USD-quoted holding on far-future dates (no collision with seeded history):
 * 2099-01-06 (Tue) bar 500, a session print of 510 on 2099-01-07 (Wed), 10 shares.
 */
describe("equityBrokeragePositionMeta after the close (hold + fx frame)", () => {
  const TICKER = "VITEST_PM_USD";
  const TODAY = "2099-01-07";
  const UNITS = 10;
  let accountId: number | null = null;
  let movId: number | null = null;

  function seedFixture(): boolean {
    const leaf = db
      .prepare(`SELECT id FROM asset_groups WHERE slug LIKE 'brokerage_acciones__%' LIMIT 1`)
      .get() as { id: number } | undefined;
    if (!leaf) return false;
    accountId = Number(
      db
        .prepare(
          `INSERT INTO accounts (asset_group_id, name, notes, equity_ticker)
           VALUES (?, 'Vitest · usd equity hold fixture', 'import:panel|ticker=VITEST_PM_USD|key=vitest-pm-usd', ?)`
        )
        .run(leaf.id, TICKER).lastInsertRowid
    );
    movId = Number(
      db
        .prepare(
          `INSERT INTO movements (account_id, amount, currency, occurred_on, note, flow_kind, units_delta)
           VALUES (?, 5000, 'usd', '2099-01-02', 'vitest-pm-usd-buy', 'stock_buy', ?)`
        )
        .run(accountId, UNITS).lastInsertRowid
    );
    db.prepare(
      `INSERT OR REPLACE INTO equity_daily (ticker, trade_date, close, currency) VALUES (?, '2099-01-06', 500, 'usd')`
    ).run(TICKER);
    db.prepare(`INSERT INTO fx_daily (date, clp_per_usd) VALUES ('2099-01-06', 900)`).run();
    insertLiveMarketQuote({
      symbol: TICKER,
      kind: "equity",
      currency: "usd",
      value: 510,
      session_ymd: TODAY,
      previous_value: 500,
      fetched_at: "2099-01-07T21:05:00.000Z", // 25 min before the read: stale for the live gate, fine for the hold
    });
    insertLiveMarketQuote({
      symbol: LIVE_FX_SYMBOL,
      kind: "fx_clp_per_usd",
      currency: null,
      value: 950,
      session_ymd: TODAY,
      previous_value: 900,
      fetched_at: "2099-01-07T21:29:00.000Z",
    });
    return true;
  }

  afterEach(() => {
    vi.useRealTimers();
    db.prepare(`DELETE FROM equity_daily WHERE ticker = ?`).run(TICKER);
    db.prepare(`DELETE FROM fx_daily WHERE date >= '2099-01-01'`).run();
    if (movId != null) db.prepare(`DELETE FROM movements WHERE id = ?`).run(movId);
    if (accountId != null) db.prepare(`DELETE FROM accounts WHERE id = ?`).run(accountId);
    movId = null;
    accountId = null;
  });

  it("holds the session's last print at the live fx between the NYSE close and the fx day end", () => {
    if (!seedFixture()) return;
    // 16:30 New York (EST): NYSE closed, fx day open until 17:05; Chile 18:30 the same date.
    const now = new Date("2099-01-07T21:30:00.000Z");
    vi.useFakeTimers();
    vi.setSystemTime(now);

    const meta = equityBrokeragePositionMeta(accountId!, TICKER, TODAY, now);
    expect(meta?.units).toBeCloseTo(UNITS, 9);
    expect(meta?.afp_override_value_as_of).toBe(TODAY);
    expect(meta?.afp_override_valor_cuota_clp).toBeCloseTo(510 * 950, 4);
    expect(meta?.afp_override_value_clp).toBeCloseTo(UNITS * 510 * 950, 2);
  });

  it("prices today's bar at the live fx while the fx day is open, the stored close after", () => {
    if (!seedFixture()) return;
    db.prepare(
      `INSERT OR REPLACE INTO equity_daily (ticker, trade_date, close, currency) VALUES (?, ?, 512, 'usd')`
    ).run(TICKER, TODAY);

    const fxDayOpen = new Date("2099-01-07T21:30:00.000Z");
    vi.useFakeTimers();
    vi.setSystemTime(fxDayOpen);
    const open = equityBrokeragePositionMeta(accountId!, TICKER, TODAY, fxDayOpen);
    expect(open?.afp_override_value_as_of).toBe(TODAY);
    // Not 512 × 900 (Tuesday's stored close): the bar landed while the fx day was still open.
    expect(open?.afp_override_value_clp).toBeCloseTo(UNITS * 512 * 950, 2);

    // 17:30 New York: the fx day has ended and its close is stored.
    db.prepare(`INSERT INTO fx_daily (date, clp_per_usd) VALUES (?, 940)`).run(TODAY);
    const fxDayClosed = new Date("2099-01-07T22:30:00.000Z");
    vi.setSystemTime(fxDayClosed);
    const closed = equityBrokeragePositionMeta(accountId!, TICKER, TODAY, fxDayClosed);
    expect(closed?.afp_override_value_clp).toBeCloseTo(UNITS * 512 * 940, 2);
  });
});
