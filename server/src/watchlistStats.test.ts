import { afterEach, describe, expect, it } from "vitest";
import { db } from "./db.js";
import type { MarketDisplaySeriesRow } from "./marketDisplaySeries.js";
import { watchlistStatsForRow } from "./watchlistStats.js";

function row(partial: Partial<MarketDisplaySeriesRow> & Pick<MarketDisplaySeriesRow, "kind">): MarketDisplaySeriesRow {
  return {
    id: 1,
    slug: "test",
    label: "Test",
    label_i18n_key: null,
    sort_order: 0,
    series_key: null,
    show_in_marquee: 0,
    show_in_rates: 0,
    rates_chart_title: null,
    source: "builtin",
    ...partial,
  };
}

describe("watchlistStatsForRow", () => {
  it("computes change fields for SPY in the display unit when EOD history exists", () => {
    const spy = row({ kind: "equity", series_key: "SPY", slug: "spy", label: "SPY" });
    const usd = watchlistStatsForRow(spy, new Date(), "usd");
    expect(usd.value).not.toBeNull();
    expect(usd.value_currency).toBe("usd");
    expect(usd.changes).not.toBeNull();
    expect(usd.changes?.day_pct).not.toBeUndefined();
    // In pesos the same close is converted at the day's rate.
    const clp = watchlistStatsForRow(spy, new Date(), "clp");
    expect(clp.value_currency).toBe("clp");
    expect(clp.value!).toBeGreaterThan(usd.value! * 100);
  });
});

/**
 * Far-future fixtures (no collision with seeded history): Mon 2099-01-05 and Tue 2099-01-06
 * bars plus fx closes, read on Wed 2099-01-07 at 04:00 Chile (pre-open, so both tickers
 * resolve to Tuesday's bar with Monday's as the prior close).
 */
describe("watchlistStatsForRow in the display unit", () => {
  const USD_TICKER = "VITEST_WL_USD";
  const SN_TICKER = "VITEST_WL.SN";
  const now = new Date("2099-01-07T04:00:00-03:00");

  function seed(): void {
    const eod = db.prepare(
      `INSERT OR REPLACE INTO equity_daily (ticker, trade_date, close, currency) VALUES (?, ?, ?, ?)`
    );
    eod.run(USD_TICKER, "2099-01-05", 500, "usd");
    eod.run(USD_TICKER, "2099-01-06", 510, "usd");
    eod.run(SN_TICKER, "2099-01-05", 1250, "clp");
    eod.run(SN_TICKER, "2099-01-06", 1300, "clp");
    const fx = db.prepare(`INSERT INTO fx_daily (date, clp_per_usd) VALUES (?, ?)`);
    fx.run("2099-01-05", 900);
    fx.run("2099-01-06", 950);
  }

  afterEach(() => {
    db.prepare(`DELETE FROM equity_daily WHERE ticker IN (?, ?)`).run(USD_TICKER, SN_TICKER);
    db.prepare(`DELETE FROM fx_daily WHERE date >= '2099-01-01'`).run();
  });

  it("leaves a series quoted in the requested unit untouched", () => {
    seed();
    const usd = watchlistStatsForRow(row({ kind: "equity", series_key: USD_TICKER }), now, "usd");
    expect(usd.value_currency).toBe("usd");
    expect(usd.value).toBe(510);
    expect(usd.as_of_date).toBe("2099-01-06");
    expect(usd.changes?.day_pct).toBeCloseTo(2, 6);

    const clp = watchlistStatsForRow(row({ kind: "equity", series_key: SN_TICKER }), now, "clp");
    expect(clp.value_currency).toBe("clp");
    expect(clp.value).toBe(1300);
    expect(clp.changes?.day_pct).toBeCloseTo(4, 6);
  });

  it("converts a USD ticker into CLP leg by leg: price × fx on each leg's own day", () => {
    seed();
    const stats = watchlistStatsForRow(row({ kind: "equity", series_key: USD_TICKER }), now, "clp");
    expect(stats.value_currency).toBe("clp");
    expect(stats.value).toBeCloseTo(510 * 950, 6);
    // Day change = (510 × 950) / (500 × 900) − 1: the price move AND the fx move, like the
    // account row's day P/L — not the 2% price-only chip.
    expect(stats.changes?.day_pct).toBeCloseTo(((510 * 950) / (500 * 900) - 1) * 100, 6);
  });

  it("converts a CLP-quoted .SN ticker into USD the same way", () => {
    seed();
    const stats = watchlistStatsForRow(row({ kind: "equity", series_key: SN_TICKER }), now, "usd");
    expect(stats.value_currency).toBe("usd");
    expect(stats.value).toBeCloseTo(1300 / 950, 9);
    expect(stats.changes?.day_pct).toBeCloseTo((1300 / 950 / (1250 / 900) - 1) * 100, 6);
  });

  it("keeps the USD/CLP rate row as CLP per USD in USD mode", () => {
    seed();
    const stats = watchlistStatsForRow(row({ kind: "fx_usd", series_key: null }), now, "usd");
    expect(stats.value_currency).toBe("clp");
    expect(stats.as_of_date).not.toBeNull();
  });

  it("converts into EUR through the rates walk on each leg's own day", () => {
    seed();
    const fxr = db.prepare(`INSERT OR REPLACE INTO fx_rates (base, quote, date, mid, source) VALUES ('eur', 'usd', ?, ?, 'vitest')`);
    fxr.run("2099-01-05", 1.2);
    fxr.run("2099-01-06", 1.25);
    const eurClp = db.prepare(`INSERT OR REPLACE INTO eur_daily (date, clp_per_eur) VALUES (?, ?)`);
    eurClp.run("2099-01-05", 1000);
    eurClp.run("2099-01-06", 1100);
    try {
      const usd = watchlistStatsForRow(row({ kind: "equity", series_key: USD_TICKER }), now, "eur");
      expect(usd.value_currency).toBe("eur");
      expect(usd.value).toBeCloseTo(510 / 1.25, 9);
      expect(usd.changes?.day_pct).toBeCloseTo((510 / 1.25 / (500 / 1.2) - 1) * 100, 6);
      // A peso series converts through the direct EUR/CLP pair.
      const sn = watchlistStatsForRow(row({ kind: "equity", series_key: SN_TICKER }), now, "eur");
      expect(sn.value).toBeCloseTo(1300 / 1100, 9);
      expect(sn.changes?.day_pct).toBeCloseTo((1300 / 1100 / (1250 / 1000) - 1) * 100, 6);
      // The USD/CLP row stays the rate.
      expect(watchlistStatsForRow(row({ kind: "fx_usd", series_key: null }), now, "eur").value_currency).toBe("clp");
      // The EUR rate rows are the rates themselves in every unit: dollars / pesos per euro.
      for (const unit of ["clp", "usd", "eur"]) {
        const eurUsd = watchlistStatsForRow(row({ kind: "fx_pair", series_key: "eur_usd" }), now, unit);
        expect(eurUsd).toMatchObject({ value: 1.25, value_currency: "usd", as_of_date: "2099-01-06" });
        expect(eurUsd.changes?.day_pct).toBeCloseTo((1.25 / 1.2 - 1) * 100, 9);
        const eurClpRow = watchlistStatsForRow(row({ kind: "fx_pair", series_key: "eur_clp" }), now, unit);
        expect(eurClpRow).toMatchObject({ value: 1100, value_currency: "clp", as_of_date: "2099-01-06" });
        expect(eurClpRow.changes?.day_pct).toBeCloseTo(10, 9);
      }
      expect(() => watchlistStatsForRow(row({ kind: "fx_pair", series_key: "eurusd" }), now, "clp")).toThrow(/series_key/);
    } finally {
      db.prepare(`DELETE FROM fx_rates WHERE source = 'vitest'`).run();
      db.prepare(`DELETE FROM eur_daily WHERE date >= '2099-01-01'`).run();
    }
  });
});
