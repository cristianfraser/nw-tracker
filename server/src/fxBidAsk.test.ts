import { describe, expect, it } from "vitest";
import { db } from "./db.js";
import {
  ensureBidAskForPaymentDate,
  fxBuyClpPerUsdOnOrBefore,
  inferBidAskFromMid,
  materializeInferredBidAskForDate,
  upsertFxBidAskRow,
} from "./fxBidAsk.js";
import { clearFxConversionWarnings, takeFxConversionWarnings } from "./fxConversionWarnings.js";
import { clpToUsdAtPaymentRounded } from "./fxRates.js";

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

  it("ensureBidAskForPaymentDate is idempotent when buy exists", () => {
    const date = "2099-08-03";
    upsertFxBidAskRow({
      date,
      buy_clp_per_usd: 950,
      sell_clp_per_usd: 940,
      source: "test",
    });
    ensureBidAskForPaymentDate(date);
    expect(fxBuyClpPerUsdOnOrBefore(date)).toBe(950);
    db.prepare(`DELETE FROM fx_daily_bid_ask WHERE date = ?`).run(date);
  });
});
