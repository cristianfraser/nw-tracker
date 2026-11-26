import { describe, expect, it } from "vitest";
import {
  projectionFieldGroups,
  projectionFieldKey,
  projectionFieldValue,
  validProjectionOverrides,
  type ProjectionField,
} from "./projectionsFields";
import type { ProjectionParams } from "./types";

const PARAMS: ProjectionParams = {
  real_return_pct: 5,
  monthly_aporte: 1200.5,
  inflation_pct: { clp: 3.5, usd: 2.5 },
  retire_return_pct: 4,
  end_age: 95,
  swr_pct: 4,
  pct_balance_pct: 5,
  monthly_income: 0,
  liquidate_other_pct: 0,
  monthly_rent: 0,
};

const RENT: ProjectionField = { kind: "money", key: "monthly_rent" };
const END_AGE: ProjectionField = { kind: "number", key: "end_age" };

describe("projection form fields", () => {
  it("groups every request input once, an inflation field per currency", () => {
    const groups = projectionFieldGroups(["clp", "usd"]);
    expect(groups.map((g) => g.id)).toEqual(["growth", "inflation", "drawdown"]);
    const keys = groups.flatMap((g) => g.fields.map(projectionFieldKey));
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys.sort()).toEqual(
      [
        "real_return_pct",
        "monthly_aporte",
        "inflation_clp_pct",
        "inflation_usd_pct",
        "retire_return_pct",
        "end_age",
        "swr_pct",
        "pct_balance_pct",
        "monthly_income",
        "monthly_rent",
        "liquidate_other_pct",
      ].sort()
    );
  });

  it("sends only in-bounds overrides, a money input with its currency", () => {
    const fields = projectionFieldGroups(["clp"]).flatMap((g) => g.fields);
    expect(
      validProjectionOverrides(fields, {
        end_age: 120, // out of bounds: kept on screen with its message, not sent
        swr_pct: 6,
        monthly_rent: 800_000,
        monthly_rent_currency: "clp",
        inflation_clp_pct: 31,
        unknown_key: 1,
      })
    ).toEqual({ swr_pct: 6, monthly_rent: 800_000, monthly_rent_currency: "clp" });
  });

  it("shows an override typed in this unit, else the server's echo", () => {
    expect(projectionFieldValue(END_AGE, { end_age: 90 }, "usd", PARAMS)).toBe(90);
    expect(projectionFieldValue(END_AGE, {}, "usd", PARAMS)).toBe(95);
    // A money override typed in pesos reads the echo (that amount in dollars) while the unit is dollars.
    const overrides = { monthly_rent: 800_000, monthly_rent_currency: "clp" };
    expect(projectionFieldValue(RENT, overrides, "clp", PARAMS)).toBe(800_000);
    expect(projectionFieldValue(RENT, overrides, "usd", { ...PARAMS, monthly_rent: 771.2 })).toBe(771.2);
    expect(projectionFieldValue(RENT, overrides, "usd", undefined)).toBeUndefined();
  });
});
