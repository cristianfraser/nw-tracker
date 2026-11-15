import { afterAll, describe, expect, it } from "vitest";
import { db } from "./db.js";
import {
  fxBuyClpPerUsdOnOrBefore,
  inferBidAskFromMid,
  materializeInferredBidAskForDate,
  upsertFxBidAskRow,
} from "./fxBidAsk.js";
import { clearFxConversionWarnings, takeFxConversionWarnings } from "./fxConversionWarnings.js";
import { clpToUsdAtPaymentRounded } from "./fxRates.js";
import { snapshotTables } from "./test/snapshotTables.js";

// One case does `DELETE FROM fx_daily_bid_ask WHERE date <= '2099-...'`, which wipes the whole
// table; snapshot both fx tables and restore in afterAll so other files sharing the DB aren't
// left with an empty bid-ask table.
const restoreTables = snapshotTables(["fx_daily", "fx_daily_bid_ask"]);
afterAll(() => restoreTables());

describe("fxBidAsk infer", () => {
  it("inferBidAskFromMid spreads around mid", () => {
    const { buy_clp_per_usd, sell_clp_per_usd } = inferBidAskFromMid(900);
    expect(buy_clp_per_usd).toBe(902);
    expect(sell_clp_per_usd).toBe(898);
    expect(buy_clp_per_usd).toBeGreaterThan(sell_clp_per_usd);
  });

  it("materializeInferredBidAskForDate writes mid_spread_inferred", () => {
    const date = "2099-08-01";
    db.prepare(`DELETE FROM fx_daily_bid_ask WHERE date = ?`).run(date);
    db.prepare(
      `INSERT INTO fx_daily (date, clp_per_usd) VALUES (?, ?)
       ON CONFLICT(date) DO UPDATE SET clp_per_usd = excluded.clp_per_usd`
    ).run(date, 800);
    const row = materializeInferredBidAskForDate(date);
    expect(row?.source).toBe("mid_spread_inferred");
    expect(row?.buy_clp_per_usd).toBe(802);
    db.prepare(`DELETE FROM fx_daily_bid_ask WHERE date = ?`).run(date);
    db.prepare(`DELETE FROM fx_daily WHERE date = ?`).run(date);
  });

  it("clpToUsd uses inferred buy without buy_rate_missing warning", () => {
    const date = "2099-08-02";
    db.prepare(`DELETE FROM fx_daily_bid_ask WHERE date <= ?`).run(date);
    db.prepare(
      `INSERT INTO fx_daily (date, clp_per_usd) VALUES (?, ?)
       ON CONFLICT(date) DO UPDATE SET clp_per_usd = excluded.clp_per_usd`
    ).run(date, 1000);
    clearFxConversionWarnings();
    const usd = clpToUsdAtPaymentRounded(100_000, date);
    expect(usd).toBeCloseTo(100_000 / 1002, 5);
    expect(takeFxConversionWarnings()).toHaveLength(0);
    db.prepare(`DELETE FROM fx_daily_bid_ask WHERE date = ?`).run(date);
    db.prepare(`DELETE FROM fx_daily WHERE date = ?`).run(date);
  });

  it("clpToUsd preserves sign for withdrawals", () => {
    const date = "2099-08-04";
    upsertFxBidAskRow({
      date,
      buy_clp_per_usd: 1000,
      sell_clp_per_usd: 990,
      source: "test",
    });
    expect(clpToUsdAtPaymentRounded(100_000, date)).toBeCloseTo(100, 5);
    expect(clpToUsdAtPaymentRounded(-100_000, date)).toBeCloseTo(-100, 5);
    db.prepare(`DELETE FROM fx_daily_bid_ask WHERE date = ?`).run(date);
  });

  it("a conversion reads the stored buy rate and writes no bid/ask row", () => {
    const date = "2099-08-03";
    upsertFxBidAskRow({
      date,
      buy_clp_per_usd: 950,
      sell_clp_per_usd: 940,
      source: "test",
    });
    const rows = () => (db.prepare(`SELECT COUNT(*) AS n FROM fx_daily_bid_ask`).get() as { n: number }).n;
    const before = rows();
    expect(clpToUsdAtPaymentRounded(95_000, "2099-08-05")).toBeCloseTo(100, 5);
    expect(fxBuyClpPerUsdOnOrBefore(date)).toBe(950);
    expect(rows()).toBe(before);
    db.prepare(`DELETE FROM fx_daily_bid_ask WHERE date = ?`).run(date);
  });

  it("no rate on or before the date: null, with no warning recorded", () => {
    clearFxConversionWarnings();
    expect(clpToUsdAtPaymentRounded(100_000, "1900-01-01")).toBeNull();
    expect(takeFxConversionWarnings()).toHaveLength(0);
  });
});
