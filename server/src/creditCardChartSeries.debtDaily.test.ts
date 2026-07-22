import { describe, expect, it } from "vitest";
import { buildCcInstallmentDebtDailySeries } from "./creditCardChartSeries.js";

describe("buildCcInstallmentDebtDailySeries", () => {
  it("ramps on purchase dates, drops on pay-by dates, null before the first event", () => {
    const dates = [
      "2026-01-05",
      "2026-01-10",
      "2026-01-11",
      "2026-02-09",
      "2026-02-10",
      "2026-02-11",
      "2026-03-15",
    ];
    const events = [
      { iso: "2026-01-10", clp: 300000 }, // contract, 3 cuotas of 100k
      { iso: "2026-02-10", clp: -100000 }, // first cuota pay-by
      { iso: "2026-03-10", clp: -100000 },
    ];
    expect(buildCcInstallmentDebtDailySeries(dates, events)).toEqual([
      null, // before any event
      300000, // full contract on purchase day
      300000,
      300000, // flat until pay-by
      200000, // cuota leaves on its pay-by
      200000,
      100000,
    ]);
  });

  it("clamps interest-rounding residue at zero and handles empty events", () => {
    const dates = ["2026-01-01", "2026-06-01"];
    expect(
      buildCcInstallmentDebtDailySeries(dates, [
        { iso: "2026-01-01", clp: 100 },
        { iso: "2026-02-10", clp: -101 },
      ])
    ).toEqual([100, 0]);
    expect(buildCcInstallmentDebtDailySeries(dates, [])).toEqual([null, null]);
  });
});
