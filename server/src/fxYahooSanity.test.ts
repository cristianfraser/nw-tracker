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
  it("skips 2016-12-21 outlier in Dec 2016 sequence", () => {
    const series = {
      dates: ["2016-12-19", "2016-12-20", "2016-12-21", "2016-12-22"],
      closes: [664.5, 663.77, 5, 663.75],
    };
    const { accepted, rejected } = ingestYahooFxSeries(series, { dryRun: true });
    expect(accepted.map((r) => r.date)).toEqual(["2016-12-19", "2016-12-20", "2016-12-22"]);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]).toMatchObject({ date: "2016-12-21", rawClpPerUsd: 5, reason: "below_min" });
  });
});
