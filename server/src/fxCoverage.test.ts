import { afterAll, describe, expect, it, beforeEach } from "vitest";
import { db } from "./db.js";
import { buildFxCoverage } from "./fxCoverage.js";
import { depositClpToUsdAtDate } from "./flowsDeposits.js";
import { fxMonthEndForBalanceUsd } from "./fxRates.js";
import { snapshotTables } from "./test/snapshotTables.js";

/** Tables that reference `movements` — must be wiped first (FKs are ON) and restored with it. */
const MOVEMENT_CHILD_TABLES = [
  "payroll_work_earnings",
  "checking_income_movement_overrides",
  "checking_gap_deposit_mirrors",
  "expense_deposit_links",
  "cuenta_ahorro_deposit_splits",
] as const;

const restoreTables = snapshotTables([
  "fx_daily",
  "fx_daily_bid_ask",
  "fx_daily_yahoo_rejected",
  "valuations",
  "movements",
  ...MOVEMENT_CHILD_TABLES,
]);
afterAll(() => restoreTables());

function wipeMovementsAndValuations() {
  for (const t of MOVEMENT_CHILD_TABLES) db.exec(`DELETE FROM ${t}`);
  db.exec("DELETE FROM movements");
  db.exec("DELETE FROM valuations");
}

describe("buildFxCoverage", () => {
  beforeEach(() => {
    db.exec("DELETE FROM fx_daily");
    db.exec("DELETE FROM fx_daily_yahoo_rejected");
    wipeMovementsAndValuations();
  });

  it("reports incomplete when fx_daily is empty", () => {
    const c = buildFxCoverage();
    expect(c.complete).toBe(false);
    expect(c.row_count).toBe(0);
    expect(c.is_sparse).toBe(true);
    expect(c.yahoo_rejected).toEqual([]);
    expect(c.conversion_warnings).toEqual([]);
  });

  it("includes yahoo_rejected rows", () => {
    db.prepare(`INSERT INTO fx_daily_yahoo_rejected (date, raw_clp_per_usd, reason) VALUES (?, ?, ?)`).run(
      "2016-12-21",
      5,
      "below_min"
    );
    const c = buildFxCoverage();
    expect(c.yahoo_rejected).toHaveLength(1);
    expect(c.yahoo_rejected[0]?.date).toBe("2016-12-21");
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
    db.exec("DELETE FROM fx_daily_bid_ask");
  });

  it("returns null when no fx row on or before date", () => {
    expect(depositClpToUsdAtDate(1000, "2020-06-15")).toBeNull();
  });

  it("uses buy rate inferred from mid on or before event date", () => {
    db.prepare(`INSERT INTO fx_daily (date, clp_per_usd) VALUES (?, ?)`).run("2020-06-01", 800);
    expect(depositClpToUsdAtDate(800, "2020-06-15")).toBeCloseTo(800 / 802, 5);
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
