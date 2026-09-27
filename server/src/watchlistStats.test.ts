import { afterEach, describe, expect, it } from "vitest";
import { db } from "./db.js";
import type { MarketDisplaySeriesRow } from "./marketDisplaySeries.js";
import { watchlistDisplayUnitParam, watchlistStatsForRow } from "./watchlistStats.js";

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
  it("returns null stats when UF data is missing", () => {
    const stats = watchlistStatsForRow(row({ kind: "uf", slug: "uf_no_data", series_key: null }));
    if (stats.value == null) {
      expect(stats.changes).toBeNull();
    } else {
      expect(stats.value_currency).toBe("clp");
      expect(stats.changes).not.toBeNull();
    }
  });

  it("computes change fields for SPY when EOD history exists", () => {
    const stats = watchlistStatsForRow(
      row({ kind: "equity", series_key: "SPY", slug: "spy", label: "SPY" })
    );
    if (stats.value == null) return;
    expect(stats.value_currency).toBe("usd");
    expect(stats.changes).not.toBeNull();
    expect(stats.changes?.day_pct).not.toBeUndefined();
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

  it("parses the unit query param with CLP as the default", () => {
    expect(watchlistDisplayUnitParam("usd")).toBe("usd");
    expect(watchlistDisplayUnitParam("clp")).toBe("clp");
    expect(watchlistDisplayUnitParam(undefined)).toBe("clp");
    expect(watchlistDisplayUnitParam("uf")).toBe("clp");
  });
});
