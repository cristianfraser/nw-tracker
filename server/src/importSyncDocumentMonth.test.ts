import { describe, expect, it } from "vitest";
import {
  cartolaPeriodRangeCoversMonth,
  matrixMonthsForCartolaPeriodRange,
} from "./importSyncDocumentMonth.js";

describe("importSyncDocumentMonth cartola ranges", () => {
  it("expands when movements span multiple calendar months", () => {
    expect(
      matrixMonthsForCartolaPeriodRange("2018-11-01", "2019-10-31", "2019-10", [
        { occurred_on: "2018-11-05" },
        { occurred_on: "2019-10-20" },
      ])
    ).toEqual([
      "2018-11",
      "2018-12",
      "2019-01",
      "2019-02",
      "2019-03",
      "2019-04",
      "2019-05",
      "2019-06",
      "2019-07",
      "2019-08",
      "2019-09",
      "2019-10",
    ]);
  });

  it("uses statement month only for single-month boundary DESDE", () => {
    expect(
      matrixMonthsForCartolaPeriodRange("2020-03-31", "2020-04-30", "2020-04", [
        { occurred_on: "2020-04-07" },
      ])
    ).toEqual(["2020-04"]);
    expect(
      matrixMonthsForCartolaPeriodRange("2024-03-28", "2024-04-30", "2024-04", [
        { occurred_on: "2024-04-07" },
      ])
    ).toEqual(["2024-04"]);
  });

  it("falls back to period_month when range fields are missing", () => {
    expect(matrixMonthsForCartolaPeriodRange(null, null, "2021-04")).toEqual(["2021-04"]);
  });

  it("covers row month when period_month matches", () => {
    expect(
      cartolaPeriodRangeCoversMonth(
        {
          period_month: "2019-03",
          period_from: "2018-11-01",
          period_to: "2019-10-31",
        },
        "2019-03"
      )
    ).toBe(true);
    expect(
      cartolaPeriodRangeCoversMonth(
        {
          period_month: "2019-10",
          period_from: "2018-11-01",
          period_to: "2019-10-31",
        },
        "2019-03"
      )
    ).toBe(false);
  });
});
