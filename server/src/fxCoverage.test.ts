import { afterAll, describe, expect, it, beforeEach } from "vitest";
import { monthEndsBetweenInclusive } from "./calendarMonth.js";
import { chileCalendarTodayYmd } from "./chileDate.js";
import { db } from "./db.js";
import { portfolioStartYmd } from "./portfolioStart.js";
import { buildFxCoverage, fxCoveragePairsForUnit } from "./fxCoverage.js";
import { fxMonthEndForBalanceUsd } from "./fxRates.js";
import { snapshotTables } from "./test/snapshotTables.js";

// buildFxCoverage reads the rate tables of the pairs a unit walks (fx_daily, uf_daily, eur_daily,
// fx_rates) plus fx_daily_yahoo_rejected. Snapshot exactly those and restore in afterAll so wiping
// them for a controlled fixture doesn't poison later test files sharing the DB.
const restoreTables = snapshotTables([
  "fx_daily",
  "fx_daily_bid_ask",
  "fx_daily_yahoo_rejected",
  "eur_daily",
  "fx_rates",
]);
afterAll(() => restoreTables());

const key = (p: { base: string; quote: string }) => `${p.base}/${p.quote}`;

describe("fxCoveragePairsForUnit", () => {
  it("walks USD/CLP for pesos and dollars, the euro pairs for EUR", () => {
    expect(fxCoveragePairsForUnit("clp").map(key)).toContain("usd/clp");
    expect(fxCoveragePairsForUnit("usd").map(key)).toContain("usd/clp");
    const eur = fxCoveragePairsForUnit("eur").map(key);
    expect(eur).toContain("eur/clp");
    expect(eur).toContain("eur/usd");
    expect(eur).not.toContain("usd/clp");
  });
});

describe("buildFxCoverage (USD/CLP)", () => {
  beforeEach(() => {
    db.exec("DELETE FROM fx_daily");
    db.exec("DELETE FROM fx_daily_yahoo_rejected");
  });

  const usdClp = (unit: string) => buildFxCoverage(unit).pairs.find((p) => key(p) === "usd/clp")!;

  it("reports incomplete when fx_daily is empty", () => {
    const c = buildFxCoverage("usd");
    expect(c.unit).toBe("usd");
    expect(c.complete).toBe(false);
    expect(usdClp("usd").row_count).toBe(0);
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
    const c = buildFxCoverage("usd");
    expect(c.yahoo_rejected).toHaveLength(1);
    expect(c.yahoo_rejected[0]?.date).toBe("2016-12-21");
  });

  it("reports sparse when daily row count is below threshold", () => {
    db.prepare(`INSERT INTO fx_daily (date, clp_per_usd) VALUES (?, ?)`).run("2026-05-31", 900);
    const p = usdClp("usd");
    expect(p.row_count).toBe(1);
    expect(p.is_sparse).toBe(true);
  });
});

describe("buildFxCoverage (EUR)", () => {
  it("names a missing EUR/USD row and leaves USD/CLP out", () => {
    const before = buildFxCoverage("eur");
    expect(before.pairs.map(key)).not.toContain("usd/clp");
    expect(before.yahoo_rejected).toEqual([]);
    const eurUsd = before.pairs.find((p) => key(p) === "eur/usd")!;
    expect(eurUsd.row_count).toBeGreaterThan(0);
    expect(eurUsd.missing_count).toBe(0);

    // Drop every EUR/USD row through the portfolio's second month-end: both go missing.
    const monthEnd = { d: monthEndsBetweenInclusive(portfolioStartYmd(), chileCalendarTodayYmd())[1] ?? null };
    expect(monthEnd.d).toBeTruthy();
    db.prepare(`DELETE FROM fx_rates WHERE base = 'eur' AND quote = 'usd' AND date <= ?`).run(monthEnd.d);
    try {
      const after = buildFxCoverage("eur");
      const pair = after.pairs.find((p) => key(p) === "eur/usd")!;
      expect(pair.complete).toBe(false);
      expect(pair.missing_count).toBe(2);
      expect(pair.first_missing_date).toBe(monthEndsBetweenInclusive(portfolioStartYmd(), chileCalendarTodayYmd())[0]);
      expect(after.complete).toBe(false);
      expect(after.first_missing_date).toBe(
        after.pairs.map((p) => p.first_missing_date).filter(Boolean).sort()[0]
      );
    } finally {
      restoreTables();
    }
  });

  it("reports an empty EUR/CLP series as incomplete", () => {
    db.exec("DELETE FROM eur_daily");
    try {
      const pair = buildFxCoverage("eur").pairs.find((p) => key(p) === "eur/clp")!;
      expect(pair.row_count).toBe(0);
      expect(pair.complete).toBe(false);
      expect(pair.is_sparse).toBe(true);
    } finally {
      restoreTables();
    }
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
