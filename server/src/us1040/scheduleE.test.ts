import { describe, expect, it } from "vitest";
import { ADS_RECOVERY_YEARS, LAND_SHARE, SCHEDULE_E_LAW, adsDepreciation, scheduleE, scheduleEDepreciation, scheduleEForPlace, type ScheduleEPlaceInput } from "./scheduleE.js";

const YEAR_2024 = { fromYmd: "2024-01-01", throughYmd: "2024-12-31" };

function place(over: Partial<ScheduleEPlaceInput> = {}): ScheduleEPlaceInput {
  return {
    slug: "centro",
    label: "Centro",
    window: YEAR_2024,
    rentsUsd: 12_000,
    expensesUsd: { managementFees: 840, mortgageInterest: 3_000, insurance: 200, taxes: 400, utilities: 150, other: 1_500 },
    depreciation: {
      placedInServiceDate: "2020-04-06",
      basisUsd: 100_000,
      basisOrigin: "purchase_cost",
      usPersonSince: "2024-01-01",
      valueAtUsPersonSinceUsd: null,
    },
    ...over,
  };
}

describe("ADS depreciation", () => {
  const building = 100_000 * (1 - LAND_SHARE);

  it("is straight line over 30 years with the mid-month convention", () => {
    expect(ADS_RECOVERY_YEARS).toBe(30);
    // The first year (April): 8,5 of the 360 months; a full year: 12.
    expect(adsDepreciation(building, "2020-04-06", 30, { fromYmd: "2020-01-01", throughYmd: "2020-12-31" }).amountUsd).toBeCloseTo((building * 8.5) / 360, 6);
    expect(adsDepreciation(building, "2020-04-06", 30, YEAR_2024).amountUsd).toBeCloseTo(building / 30, 6);
    // Nothing before it starts and nothing after the 30 years end.
    expect(adsDepreciation(building, "2020-04-06", 30, { fromYmd: "2019-01-01", throughYmd: "2019-12-31" }).amountUsd).toBe(0);
    expect(adsDepreciation(building, "2020-04-06", 30, { fromYmd: "2050-01-01", throughYmd: "2050-12-31" }).amountUsd).toBeCloseTo((building * 3.5) / 360, 6);
    expect(adsDepreciation(building, "2020-04-06", 30, { fromYmd: "2051-01-01", throughYmd: "2051-12-31" }).amountUsd).toBe(0);
  });

  it("prorates a partial year by the days of the window", () => {
    const half = adsDepreciation(building, "2020-04-06", 30, { fromYmd: "2024-07-01", throughYmd: "2024-12-31" });
    expect(half.monthsInWindow).toBeCloseTo(6, 9);
    expect(half.amountUsd).toBeCloseTo(building / 60, 6);
  });

  it("keeps the placed-in-service date of a rental held before the residency (reading A), on the historic cost", () => {
    const d = scheduleEDepreciation(place().depreciation, { fromYmd: "2024-04-15", throughYmd: "2024-12-31" });
    expect(d.reading).toBe("from_placed_in_service");
    expect(d.startDate).toBe("2020-04-06");
    expect(d.buildingBasisUsd).toBe(80_000);
    expect(d.monthsInWindow).toBeCloseTo(12 - 3 - 14 / 30, 6);
  });

  it("restarts on arrival at the lesser of the adjusted basis and the value (reading B)", () => {
    const law = { ...SCHEDULE_E_LAW, preResidencyDepreciation: "fresh_on_arrival" as const };
    const dep = { ...place().depreciation, usPersonSince: "2024-04-15", valueAtUsPersonSinceUsd: 90_000 };
    const window = { fromYmd: "2024-04-15", throughYmd: "2024-12-31" };
    const d = scheduleEDepreciation(dep, window, law);
    // Allowable until the day before arrival: from the mid of April 2020 to April 14, 2024.
    const allowable = (80_000 * (47 + 14 / 30 + 0.5)) / 360;
    expect(d.reading).toBe("fresh_on_arrival");
    expect(d.startDate).toBe("2024-04-15");
    expect(d.buildingBasisUsd).toBeCloseTo(80_000 - allowable, 6);
    expect(d.amountUsd).toBeCloseTo((d.buildingBasisUsd * 8.5) / 360, 6);
    // A value below the adjusted basis wins.
    expect(scheduleEDepreciation({ ...dep, valueAtUsPersonSinceUsd: 50_000 }, window, law).buildingBasisUsd).toBe(40_000);
    expect(() => scheduleEDepreciation({ ...dep, valueAtUsPersonSinceUsd: null }, window, law)).toThrow(/value/);
    // A property placed in service after the arrival is not a pre-residency rental.
    expect(scheduleEDepreciation({ ...dep, placedInServiceDate: "2024-06-10" }, window, law).reading).toBe("placed_in_window");
  });
});

describe("Schedule E lines", () => {
  it("assembles every line of a full-year rental and its net", () => {
    const { lines, depreciation } = scheduleEForPlace(place());
    expect(depreciation.amountUsd).toBeCloseTo(80_000 / 30, 6);
    expect(lines.l3).toBe(12_000);
    expect(lines).toMatchObject({ l9: 200, l11: 840, l12: 3_000, l16: 400, l17: 150, l19: 1_500 });
    expect(lines.l18).toBeCloseTo(2_666.6667, 3);
    expect(lines.l20).toBeCloseTo(200 + 840 + 3_000 + 400 + 150 + 2_666.6667 + 1_500, 3);
    expect(lines.l21).toBeCloseTo(12_000 - lines.l20, 9);
  });

  it("sums the places and treats a home converted mid-year as placed in service in the window", () => {
    const converted = place({
      slug: "vitacura",
      label: "Vitacura",
      rentsUsd: 8_000,
      depreciation: { placedInServiceDate: "2024-06-10", basisUsd: 90_000, basisOrigin: "lesser_of_cost_and_value_at_conversion", usPersonSince: "2024-04-15", valueAtUsPersonSinceUsd: null },
      window: { fromYmd: "2024-04-15", throughYmd: "2024-12-31" },
    });
    const r = scheduleE([place(), converted]);
    expect(r.places[1]!.depreciation.reading).toBe("placed_in_window");
    // June is half a month: 6,5 months of the year.
    expect(r.places[1]!.lines.l18).toBeCloseTo((72_000 * 6.5) / 360, 6);
    expect(r.netUsd).toBeCloseTo(r.places[0]!.lines.l21 + r.places[1]!.lines.l21, 9);
  });
});
