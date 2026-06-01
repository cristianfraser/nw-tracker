import { describe, expect, it, beforeEach } from "vitest";
import { db } from "./db.js";
import { buildFxCoverage } from "./fxCoverage.js";
import { depositClpToUsdAtDate } from "./flowsDeposits.js";
import { fxMonthEndForBalanceUsd } from "./fxRates.js";

describe("buildFxCoverage", () => {
  beforeEach(() => {
    db.exec("DELETE FROM fx_daily");
    db.exec("DELETE FROM valuations");
    db.exec("DELETE FROM movements");
  });

  it("reports incomplete when fx_daily is empty", () => {
    const c = buildFxCoverage();
    expect(c.complete).toBe(false);
    expect(c.row_count).toBe(0);
    expect(c.is_sparse).toBe(true);
  });

  it("reports sparse when daily row count is below threshold", () => {
    db.prepare(`INSERT INTO fx_daily (date, clp_per_usd) VALUES (?, ?)`).run("2026-05-31", 900);
    const c = buildFxCoverage();
    expect(c.row_count).toBe(1);
    expect(c.is_sparse).toBe(true);
  });
});

describe("depositClpToUsdAtDate", () => {
  beforeEach(() => {
    db.exec("DELETE FROM fx_daily");
  });

  it("returns null when no fx row on or before date", () => {
    expect(depositClpToUsdAtDate(1000, "2020-06-15")).toBeNull();
  });

  it("uses fx on or before event date", () => {
    db.prepare(`INSERT INTO fx_daily (date, clp_per_usd) VALUES (?, ?)`).run("2020-06-01", 800);
    expect(depositClpToUsdAtDate(800, "2020-06-15")).toBe(1);
  });
});

describe("fxMonthEndForBalanceUsd", () => {
  beforeEach(() => {
    db.exec("DELETE FROM fx_daily");
  });

  it("returns null when series does not cover date", () => {
    expect(fxMonthEndForBalanceUsd("2010-01-31")).toBeNull();
  });
});
