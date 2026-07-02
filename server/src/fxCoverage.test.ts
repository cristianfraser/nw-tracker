import { afterAll, describe, expect, it, beforeEach } from "vitest";
import { db } from "./db.js";
import { buildFxCoverage } from "./fxCoverage.js";
import { depositClpToUsdAtDate } from "./flowsDeposits.js";
import { fxMonthEndForBalanceUsd } from "./fxRates.js";
import { snapshotTables } from "./test/snapshotTables.js";

// These fx functions read only the fx tables (buildFxCoverage → fx_daily +
// fx_daily_yahoo_rejected; depositClpToUsdAtDate / fxMonthEndForBalanceUsd → fx_daily
// [+ bid-ask]). Snapshot exactly those and restore in afterAll so wiping them for a
// controlled fixture doesn't poison later test files sharing the DB.
const restoreTables = snapshotTables([
  "fx_daily",
  "fx_daily_bid_ask",
  "fx_daily_yahoo_rejected",
]);
afterAll(() => restoreTables());

describe("buildFxCoverage", () => {
  beforeEach(() => {
    db.exec("DELETE FROM fx_daily");
    db.exec("DELETE FROM fx_daily_yahoo_rejected");
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
