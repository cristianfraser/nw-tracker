import { describe, expect, it } from "vitest";
import {
  LEGACY_PROJECTION_OVERRIDES_KEY,
  PROJECTION_OVERRIDES_KEY,
  migrateLegacyProjectionOverrides,
  readStoredProjectionOverrides,
} from "./projectionsOverrides";

function memoryStorage(init: Record<string, string>): Storage {
  const m = new Map(Object.entries(init));
  return {
    get length() {
      return m.size;
    },
    clear: () => m.clear(),
    getItem: (k) => m.get(k) ?? null,
    key: (i) => [...m.keys()][i] ?? null,
    removeItem: (k) => void m.delete(k),
    setItem: (k, v) => void m.set(k, v),
  };
}

describe("projection overrides", () => {
  it("reads the old peso inputs as amounts typed in pesos and keeps the rest", () => {
    expect(
      migrateLegacyProjectionOverrides({
        monthly_aporte_clp: 800_000,
        monthly_rent_clp: 400_000,
        inflation_usd_pct: 3,
        swr_pct: 3.5,
        junk: "x",
      })
    ).toEqual({
      monthly_aporte: 800_000,
      monthly_aporte_currency: "clp",
      monthly_rent: 400_000,
      monthly_rent_currency: "clp",
      inflation_usd_pct: 3,
      swr_pct: 3.5,
    });
  });

  it("migrates the legacy key once, then reads the new one", () => {
    const storage = memoryStorage({ [LEGACY_PROJECTION_OVERRIDES_KEY]: JSON.stringify({ monthly_income_clp: 2_000_000 }) });
    expect(readStoredProjectionOverrides(storage)).toEqual({ monthly_income: 2_000_000, monthly_income_currency: "clp" });
    expect(storage.getItem(LEGACY_PROJECTION_OVERRIDES_KEY)).toBeNull();
    expect(JSON.parse(storage.getItem(PROJECTION_OVERRIDES_KEY)!)).toEqual({
      monthly_income: 2_000_000,
      monthly_income_currency: "clp",
    });
    expect(readStoredProjectionOverrides(storage)).toEqual({ monthly_income: 2_000_000, monthly_income_currency: "clp" });
  });
});
