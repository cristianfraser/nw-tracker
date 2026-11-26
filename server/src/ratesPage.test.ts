import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { db } from "./db.js";
import { fxBidAskGapsByYear, type FxBidAskGapRow } from "./fxBidAskGaps.js";
import type { FxCoverage, FxCoveragePair } from "./fxCoverage.js";
import { buildRatesCoverageNotices, getRatesGlancePayload } from "./ratesPage.js";
import { snapshotTables } from "./test/snapshotTables.js";

const TABLES = ["fx_daily", "uf_daily", "eur_daily", "ipc_daily", "fx_rates", "live_market_quotes"] as const;
const restoreTables = snapshotTables(TABLES);
afterAll(() => restoreTables());

// A Saturday: no fx day is open, so every rate is its stored close.
const NOW = new Date("2024-03-16T15:00:00Z");

beforeEach(() => {
  for (const t of TABLES) db.prepare(`DELETE FROM ${t}`).run();
  const fx = db.prepare(`INSERT INTO fx_daily (date, clp_per_usd) VALUES (?, ?)`);
  fx.run("2024-02-15", 950);
  fx.run("2024-03-14", 990);
  fx.run("2024-03-15", 1000);
  const uf = db.prepare(`INSERT INTO uf_daily (date, clp_per_uf) VALUES (?, ?)`);
  uf.run("2024-03-15", 37_000);
  uf.run("2024-03-16", 37_037);
  uf.run("2024-04-09", 37_500); // published ahead: not today's value
  db.prepare(`INSERT INTO eur_daily (date, clp_per_eur) VALUES (?, ?)`).run("2024-03-15", 1090);
  db.prepare(`INSERT INTO fx_rates (base, quote, date, mid, source) VALUES ('eur', 'usd', ?, ?, 'vitest')`).run(
    "2024-03-15",
    1.09
  );
  const ipc = db.prepare(`INSERT INTO ipc_daily (date, ipc_index) VALUES (?, ?)`);
  ipc.run("2023-02-01", 100);
  ipc.run("2023-12-01", 104);
  ipc.run("2024-01-01", 105);
  ipc.run("2024-02-01", 106.05);
});

describe("getRatesGlancePayload", () => {
  it("lists the five rate rows in their own quote whatever the display unit", () => {
    const usd = getRatesGlancePayload(NOW, "usd");
    expect(usd.currencies.map((r) => [r.id, r.kind, r.base, r.quote, r.value_currency])).toEqual([
      ["usd_clp", "fx_usd", "usd", "clp", "clp"],
      ["uf_clp", "uf", "uf", "clp", "clp"],
      ["eur_clp", "fx_pair", "eur", "clp", "clp"],
      ["eur_usd", "fx_pair", "eur", "usd", "usd"],
      ["ipc", "index", null, null, "none"],
    ]);
    const byId = new Map(usd.currencies.map((r) => [r.id, r]));
    expect(byId.get("usd_clp")!.value).toBe(1000);
    expect(byId.get("usd_clp")!.as_of_date).toBe("2024-03-15");
    // The UF is its peso value in every unit, and never a value published for a later day.
    expect(byId.get("uf_clp")!.value).toBe(37_037);
    expect(byId.get("uf_clp")!.changes!.day_pct).toBeCloseTo((37 / 37_000) * 100, 9);
    expect(byId.get("eur_clp")!.value).toBe(1090);
    expect(byId.get("eur_usd")!.value).toBe(1.09);
    expect(getRatesGlancePayload(NOW, "clp").currencies).toEqual(usd.currencies);
  });

  it("reads the IPC's changes from its monthly index", () => {
    const ipc = getRatesGlancePayload(NOW, "clp").currencies.find((r) => r.id === "ipc")!;
    expect(ipc.value).toBe(106.05);
    expect(ipc.as_of_date).toBe("2024-02-01");
    expect(ipc.changes).toEqual({
      day_pct: null,
      week_pct: null,
      mtd_pct: null,
      mom_pct: expect.closeTo(1, 9),
      ytd_pct: expect.closeTo(((106.05 - 104) / 104) * 100, 9),
      yoy_pct: expect.closeTo(6.05, 9),
      // No index on file that far back.
      y3_pct: null,
      y5_pct: null,
      y10_pct: null,
    });
  });

  it("leaves a rate with nothing on file valueless instead of dropping its row", () => {
    db.prepare(`DELETE FROM ipc_daily`).run();
    db.prepare(`DELETE FROM fx_rates`).run();
    const rows = new Map(getRatesGlancePayload(NOW, "clp").currencies.map((r) => [r.id, r]));
    expect(rows.get("ipc")).toMatchObject({ value: null, changes: null, as_of_date: null });
    expect(rows.get("eur_usd")).toMatchObject({ value: null, changes: null });
  });
});

function pair(over: Partial<FxCoveragePair>): FxCoveragePair {
  return {
    base: "usd",
    quote: "clp",
    complete: true,
    first_missing_date: null,
    missing_count: 0,
    fx_min: "2020-01-01",
    fx_max: "2024-03-15",
    daily_count: 900,
    row_count: 1000,
    is_sparse: false,
    max_gap_days: 3,
    ...over,
  };
}

function coverage(over: Partial<FxCoverage>): FxCoverage {
  return {
    unit: "usd",
    pairs: [pair({})],
    complete: true,
    first_missing_date: null,
    missing_count: 0,
    is_sparse: false,
    yahoo_rejected: [],
    conversion_warnings: [],
    ...over,
  };
}

describe("buildRatesCoverageNotices", () => {
  it("is empty when every pair is covered", () => {
    expect(buildRatesCoverageNotices(coverage({}))).toEqual([]);
  });

  it("names each problem with its pair, in the order drawn", () => {
    const notices = buildRatesCoverageNotices(
      coverage({
        unit: "eur",
        pairs: [
          pair({}),
          pair({ base: "eur", quote: "usd", complete: false, first_missing_date: "2024-03-01", missing_count: 4 }),
          pair({ base: "uf", quote: "clp", is_sparse: true, daily_count: 12, row_count: 40, max_gap_days: 31 }),
        ],
        yahoo_rejected: Array.from({ length: 7 }, (_, i) => ({
          date: `2016-12-0${i + 1}`,
          raw_clp_per_usd: 5 + i,
          reason: "vitest",
        })),
        conversion_warnings: [
          { code: "reference_rate", date: "2024-01-05" },
          { code: "buy_rate_missing", date: "2024-02-01" },
          { code: "reference_rate", date: "2024-03-08" },
        ],
      })
    );
    expect(notices).toEqual([
      { kind: "missing_rates", base: "eur", quote: "usd", unit: "eur", first_missing_date: "2024-03-01", missing_count: 4 },
      { kind: "sparse_history", base: "uf", quote: "clp", daily_count: 12, row_count: 40, max_gap_days: 31 },
      {
        kind: "rejected_dates",
        base: "usd",
        quote: "clp",
        count: 7,
        dates: [1, 2, 3, 4, 5].map((d) => ({ date: `2016-12-0${d}`, raw_rate: 4 + d })),
      },
      { kind: "buy_rate_missing", base: "usd", quote: "clp", date: "2024-02-01" },
      // One notice per kind, at its latest date.
      { kind: "reference_rate", base: "usd", quote: "clp", date: "2024-03-08" },
    ]);
  });
});

describe("fxBidAskGapsByYear", () => {
  const gap = (date: string): FxBidAskGapRow => ({
    date,
    mid_clp_per_usd: 900,
    buy_clp_per_usd: null,
    sell_clp_per_usd: null,
    source: null,
    suggested_buy: 902,
    suggested_sell: 898,
  });

  it("groups the days by year, newest first, without dropping any", () => {
    const out = fxBidAskGapsByYear([gap("2023-05-02"), gap("2024-01-10"), gap("2023-11-30"), gap("2024-03-01")]);
    expect(out.count).toBe(4);
    expect(out.years.map((y) => [y.year, y.count, y.first_date, y.last_date, y.rows.map((r) => r.date)])).toEqual([
      [2024, 2, "2024-01-10", "2024-03-01", ["2024-03-01", "2024-01-10"]],
      [2023, 2, "2023-05-02", "2023-11-30", ["2023-11-30", "2023-05-02"]],
    ]);
  });

  it("is an empty list for no gaps", () => {
    expect(fxBidAskGapsByYear([])).toEqual({ count: 0, years: [] });
  });
});
