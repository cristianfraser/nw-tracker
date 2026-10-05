import { describe, expect, it } from "vitest";
import {
  enrichNyseEodSeriesFromMeta,
  parseYahooDailyCloseSeries,
  type YahooChartResult,
} from "./equityYahooEod.js";

function chartResult(
  timestamps: number[],
  closes: (number | null)[],
  meta?: YahooChartResult["meta"]
): YahooChartResult {
  return {
    meta,
    timestamp: timestamps,
    indicators: { quote: [{ close: closes }] },
  };
}

describe("parseYahooDailyCloseSeries", () => {
  it("drops daily bars with null close", () => {
    const ts = [1_718_640_000, 1_718_726_400];
    const parsed = parseYahooDailyCloseSeries(
      "SPY",
      chartResult(ts, [600.1, null])
    );
    expect(parsed.yahooLatestDate).toBe("2024-06-17");
    expect(parsed.series.dates).toEqual(["2024-06-17"]);
    expect(parsed.series.closes).toEqual([600.1]);
  });

  it("drops the Sunday-evening quote of an index that trades around the clock", () => {
    const sec = (iso: string) => Math.floor(new Date(iso).getTime() / 1000);
    // ICE dollar index: Friday's bar, then the in-progress quote of Sunday 22:18 New York.
    const parsed = parseYahooDailyCloseSeries(
      "DX-Y.NYB",
      chartResult([sec("2026-10-02T04:00:00Z"), sec("2026-10-05T02:18:44Z")], [101.93, 102.135])
    );
    expect(parsed.series.dates).toEqual(["2026-10-02"]);
  });
});

describe("enrichNyseEodSeriesFromMeta", () => {
  it("appends due session close from chart meta when daily bar is missing", () => {
    const series = {
      dates: ["2026-06-16"],
      closes: [600],
    };
    const enriched = enrichNyseEodSeriesFromMeta(
      series,
      {
        regularMarketPrice: 605.25,
        regularMarketTime: Math.floor(new Date("2026-06-17T20:00:00-04:00").getTime() / 1000),
      },
      "2026-06-17"
    );
    expect(enriched.usedMetaClose).toBe(true);
    expect(enriched.series.dates).toEqual(["2026-06-16", "2026-06-17"]);
    expect(enriched.series.closes).toEqual([600, 605.25]);
  });

  it("does not use meta when session date does not match due session", () => {
    const series = { dates: ["2026-06-16"], closes: [600] };
    const enriched = enrichNyseEodSeriesFromMeta(
      series,
      {
        regularMarketPrice: 605.25,
        regularMarketTime: Math.floor(new Date("2026-06-16T20:00:00-04:00").getTime() / 1000),
      },
      "2026-06-17"
    );
    expect(enriched.usedMetaClose).toBe(false);
    expect(enriched.series).toEqual(series);
  });

  it("does not duplicate when daily series already includes due session", () => {
    const series = { dates: ["2026-06-17"], closes: [605.25] };
    const enriched = enrichNyseEodSeriesFromMeta(
      series,
      {
        regularMarketPrice: 605.25,
        regularMarketTime: Math.floor(new Date("2026-06-17T20:00:00-04:00").getTime() / 1000),
      },
      "2026-06-17"
    );
    expect(enriched.usedMetaClose).toBe(false);
    expect(enriched.series).toEqual(series);
  });
});
