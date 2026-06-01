import { describe, expect, it } from "vitest";
import { cartolaStatementMonths, isCartolaDesdeBoundaryPhantomMonth } from "./calendarMonth.js";

describe("cartolaStatementMonths", () => {
  it("uses single movement month when DESDE is mid-month boundary", () => {
    expect(
      cartolaStatementMonths({
        period_from: "2024-03-28",
        period_to: "2024-04-30",
        period_month: "2024-04",
        movements: [{ occurred_on: "2024-04-07" }, { occurred_on: "2024-04-24" }],
      })
    ).toEqual(["2024-04"]);
  });

  it("uses period_month for zero-movement statements", () => {
    expect(
      cartolaStatementMonths({
        period_from: "2024-03-28",
        period_to: "2024-04-30",
        period_month: "2024-04",
        movements: [],
      })
    ).toEqual(["2024-04"]);
  });

  it("expands across months when movements span multiple calendar months", () => {
    expect(
      cartolaStatementMonths({
        period_from: "2018-11-01",
        period_to: "2019-10-31",
        period_month: "2019-10",
        movements: [{ occurred_on: "2019-03-15" }, { occurred_on: "2019-10-20" }],
      })
    ).toEqual([
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

  it("excludes boundary DESDE month on multi-year annual cartolas", () => {
    expect(
      cartolaStatementMonths({
        period_from: "2016-10-28",
        period_to: "2017-10-31",
        period_month: "2017-10",
        movements: [
          { occurred_on: "2016-11-10" },
          { occurred_on: "2017-10-02" },
        ],
      })
    ).toEqual([
      "2016-11",
      "2016-12",
      "2017-01",
      "2017-02",
      "2017-03",
      "2017-04",
      "2017-05",
      "2017-06",
      "2017-07",
      "2017-08",
      "2017-09",
      "2017-10",
    ]);
    expect(
      cartolaStatementMonths({
        period_from: "2016-10-28",
        period_to: "2017-10-31",
        period_month: "2017-10",
        movements: [{ occurred_on: "2016-10-30" }, { occurred_on: "2016-11-10" }],
      })
    ).not.toContain("2016-10");
  });

  it("detects Oct 2016 synthetic boundary month (0 movements, saldo ref only)", () => {
    expect(
      isCartolaDesdeBoundaryPhantomMonth({
        period_month: "2016-10",
        period_from: "2016-10-28",
        period_to: "2017-10-31",
        movement_count: 0,
      })
    ).toBe(true);
    expect(
      isCartolaDesdeBoundaryPhantomMonth({
        period_month: "2016-11",
        period_from: "2016-10-28",
        period_to: "2017-10-31",
        movement_count: 3,
      })
    ).toBe(false);
  });
});
