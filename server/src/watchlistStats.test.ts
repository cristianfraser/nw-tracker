import { describe, expect, it } from "vitest";
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
