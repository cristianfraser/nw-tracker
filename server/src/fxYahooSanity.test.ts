import { describe, expect, it } from "vitest";
import { acceptYahooClpPerUsdClose } from "./fxYahooSanity.js";
import { ingestYahooFxSeries } from "./fxYahooEodSync.js";

describe("acceptYahooClpPerUsdClose", () => {
  it("rejects below minimum (2016-12-21 Yahoo outlier)", () => {
    expect(acceptYahooClpPerUsdClose(5, 663.77)).toEqual({ ok: false, reason: "below_min" });
  });

  it("accepts normal CLP/USD levels", () => {
    expect(acceptYahooClpPerUsdClose(663.77, 664.5)).toEqual({ ok: true });
    expect(acceptYahooClpPerUsdClose(663.75, 663.77)).toEqual({ ok: true });
  });

  it("rejects large day-over-day jump", () => {
    expect(acceptYahooClpPerUsdClose(900, 600)).toEqual({ ok: false, reason: "day_jump" });
  });
});

describe("ingestYahooFxSeries", () => {
  it("skips a below-min outlier inside an otherwise sane sequence", () => {
    // Modeled on the real 2016-12-21 Yahoo glitch (close of 5). Dates are far-future so
    // they clear the ingest's portfolioStartYmd() anchor on any dataset.
    const series = {
      dates: ["2099-06-01", "2099-06-02", "2099-06-03", "2099-06-04"],
      closes: [664.5, 663.77, 5, 663.75],
    };
    const { accepted, rejected } = ingestYahooFxSeries(series, { dryRun: true });
    expect(accepted.map((r) => r.date)).toEqual(["2099-06-01", "2099-06-02", "2099-06-04"]);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]).toMatchObject({ date: "2099-06-03", rawClpPerUsd: 5, reason: "below_min" });
  });
});
