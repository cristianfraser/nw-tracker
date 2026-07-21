import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { getAccountPositionMeta } from "./accountPosition.js";
import { db } from "./db.js";
import { clearLiveMarketQuotesForTest, insertLiveMarketQuote } from "./liveMarketQuotesDb.js";
import { utcTodayYmd } from "./nyseSession.js";

/**
 * Regression: crypto position meta must value a TODAY position with the cached live quote
 * (like `equityBrokeragePositionMeta`), not the last completed UTC EOD close. The raw-EOD
 * version pinned dashboard crypto rows at yesterday's close, which zeroed their day delta —
 * the calendar-day anchor mark IS that same close.
 */

const TICKER = "BTC-USD";
const UNITS = 0.5;
const EOD_CLOSE_USD = 60_000;
const LIVE_PRICE_USD = 66_000;

function yesterdayUtcYmd(): string {
  const d = new Date(Date.now() - 24 * 60 * 60 * 1000);
  return d.toISOString().slice(0, 10);
}

let accountId: number | null = null;
let insertedEodDate: string | null = null;

beforeAll(() => {
  const leaf = db
    .prepare(`SELECT id FROM asset_groups WHERE slug = 'brokerage_crypto__bitcoin' LIMIT 1`)
    .get() as { id: number } | undefined;
  if (!leaf) return;

  accountId = Number(
    db
      .prepare(
        `INSERT INTO accounts (asset_group_id, name, notes, import_key, equity_ticker)
         VALUES (?, 'Vitest · crypto live position', 'vitest-crypto-live-pos', 'vitest-crypto-live-pos', ?)`
      )
      .run(leaf.id, TICKER).lastInsertRowid
  );
  db.prepare(
    `INSERT INTO movements (account_id, amount_clp, occurred_on, note, units_delta)
     VALUES (?, 1000, '2026-01-10', 'vitest-crypto-live-pos-buy', ?)`
  ).run(accountId, UNITS);

  const eodDate = yesterdayUtcYmd();
  const existing = db
    .prepare(`SELECT 1 FROM equity_daily WHERE ticker = ? AND trade_date = ?`)
    .get(TICKER, eodDate);
  if (!existing) {
    db.prepare(
      `INSERT INTO equity_daily (ticker, trade_date, close, currency) VALUES (?, ?, ?, 'usd')`
    ).run(TICKER, eodDate, EOD_CLOSE_USD);
    insertedEodDate = eodDate;
  }
});

afterEach(() => {
  clearLiveMarketQuotesForTest();
});

afterAll(() => {
  if (insertedEodDate != null) {
    db.prepare(`DELETE FROM equity_daily WHERE ticker = ? AND trade_date = ?`).run(
      TICKER,
      insertedEodDate
    );
  }
  if (accountId != null) {
    db.prepare(`DELETE FROM movements WHERE account_id = ?`).run(accountId);
    db.prepare(`DELETE FROM accounts WHERE id = ?`).run(accountId);
  }
});

describe("crypto position meta — live vs EOD", () => {
  it("without a live quote, values at the last completed EOD close", () => {
    if (accountId == null) return;
    const meta = getAccountPositionMeta(accountId, "bitcoin");
    if (meta?.afp_override_value_clp == null) return; // fx row missing in this DB — nothing to assert
    expect(meta.afp_override_value_as_of).not.toBe(utcTodayYmd());
  });

  it("with a fresh live quote, values live and dates the mark today (UTC session)", () => {
    if (accountId == null) return;
    const eodMeta = getAccountPositionMeta(accountId, "bitcoin");
    insertLiveMarketQuote({
      symbol: TICKER,
      kind: "equity",
      currency: "usd",
      value: LIVE_PRICE_USD,
      session_ymd: utcTodayYmd(),
      previous_value: EOD_CLOSE_USD,
      fetched_at: new Date().toISOString(),
    });
    const liveMeta = getAccountPositionMeta(accountId, "bitcoin");
    if (liveMeta?.afp_override_value_clp == null) return;

    expect(liveMeta.afp_override_value_as_of).toBe(utcTodayYmd());
    if (eodMeta?.afp_override_value_clp != null) {
      // Same fx fallback row on both legs → the value ratio tracks the price ratio.
      const ratio = liveMeta.afp_override_value_clp / eodMeta.afp_override_value_clp;
      expect(ratio).toBeGreaterThan(1.05);
      expect(ratio).toBeLessThan(1.15);
    }
  });
});
