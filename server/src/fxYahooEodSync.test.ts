import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "./db.js";
import { snapshotTables } from "./test/snapshotTables.js";
import {
  fxSeriesWithMetaForDue,
  ingestYahooFxSeries,
  isYahooFxUsdStale,
  syncYahooFxUsdFromYahoo,
  yahooFxUsdCaughtUp,
  yahooFxUsdSyncDue,
} from "./fxYahooEodSync.js";
import { insertFxRowsIfMissing } from "./sbifSyncDb.js";

// Friday 2026-06-05 (Chile winter -04, New York EDT -04): the fx day ends 17:05 on both clocks.
const FRI_AFTER_END = new Date("2026-06-05T21:30:00.000Z"); // 17:30 Chile/NY
const FRI_BEFORE_END = new Date("2026-06-05T20:00:00.000Z"); // 16:00 Chile/NY

type FetchedFx = {
  series: { dates: string[]; closes: number[] };
  meta: { regularMarketPrice?: number; regularMarketTime?: number } | undefined;
};

// `vi.mock` factories are hoisted above every import, so the mock they close over must be too.
const mocks = vi.hoisted(() => ({ fetchWithMeta: vi.fn<() => Promise<FetchedFx>>() }));

vi.mock("./equityYahooEod.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./equityYahooEod.js")>();
  return { ...actual, fetchYahooRecentDailyClosesWithMeta: mocks.fetchWithMeta };
});

const DEFAULT_FETCH: FetchedFx = {
  series: { dates: ["2026-06-04", "2026-06-05", "2026-06-06"], closes: [909.5, 910.29, 911.0] },
  meta: undefined,
};

const restoreTables = snapshotTables(["fx_daily"]);
afterAll(() => restoreTables());

beforeEach(() => {
  db.exec("DELETE FROM fx_daily");
  mocks.fetchWithMeta.mockReset();
  mocks.fetchWithMeta.mockResolvedValue(DEFAULT_FETCH);
});

afterEach(() => {
  db.exec("DELETE FROM fx_daily");
});

function fxAt(date: string): number | null {
  const row = db.prepare(`SELECT clp_per_usd FROM fx_daily WHERE date = ?`).get(date) as
    | { clp_per_usd: number }
    | undefined;
  return row?.clp_per_usd ?? null;
}

describe("yahooFxUsdSyncDue", () => {
  it("is today after 17:05 New York, the prior weekday before it", () => {
    expect(yahooFxUsdSyncDue(FRI_AFTER_END)).toBe("2026-06-05");
    expect(yahooFxUsdSyncDue(FRI_BEFORE_END)).toBe("2026-06-04");
  });
});

describe("yahooFxUsdCaughtUp", () => {
  it("is true when fx_daily has the due day", () => {
    insertFxRowsIfMissing([{ date: "2026-06-05", clpPerUsd: 910.29 }]);
    expect(yahooFxUsdCaughtUp("2026-06-05")).toBe(true);
    expect(yahooFxUsdCaughtUp("2026-06-08")).toBe(false);
  });
});

describe("isYahooFxUsdStale", () => {
  it("is stale after the day end until the due day's row lands", () => {
    expect(isYahooFxUsdStale({ now: FRI_AFTER_END })).toBe(true);
    insertFxRowsIfMissing([{ date: "2026-06-05", clpPerUsd: 910.29 }]);
    expect(isYahooFxUsdStale({ now: FRI_AFTER_END })).toBe(false);
  });

  it("carries a missed day over: Saturday still wants Friday's row", () => {
    expect(isYahooFxUsdStale({ now: new Date("2026-06-06T15:00:00.000Z") })).toBe(true);
  });
});

describe("ingestYahooFxSeries", () => {
  it("drops weekend-dated bars (Yahoo's Sunday-labelled week-open bar)", () => {
    const { accepted } = ingestYahooFxSeries(
      { dates: ["2026-06-05", "2026-06-07", "2026-06-08"], closes: [910, 915, 912] },
      { dryRun: true }
    );
    expect(accepted.map((r) => r.date)).toEqual(["2026-06-05", "2026-06-08"]);
  });
});

describe("fxSeriesWithMetaForDue", () => {
  it("appends the chart quote for the due day when no bar carries that date", () => {
    const series = { dates: ["2026-06-04"], closes: [909.5] };
    const meta = { regularMarketPrice: 910.7, regularMarketTime: Math.floor(FRI_AFTER_END.getTime() / 1000) };
    const out = fxSeriesWithMetaForDue(series, meta, "2026-06-05");
    expect(out.usedMetaQuote).toBe(true);
    expect(out.series).toEqual({ dates: ["2026-06-04", "2026-06-05"], closes: [909.5, 910.7] });
  });

  it("leaves the series alone when the quote was printed on another day", () => {
    const series = { dates: ["2026-06-04"], closes: [909.5] };
    const meta = { regularMarketPrice: 910.7, regularMarketTime: Math.floor(FRI_BEFORE_END.getTime() / 1000) - 86400 };
    expect(fxSeriesWithMetaForDue(series, meta, "2026-06-05").usedMetaQuote).toBe(false);
  });
});

describe("syncYahooFxUsdFromYahoo", () => {
  it("inserts the weekday bars, never the Saturday one", async () => {
    const result = await syncYahooFxUsdFromYahoo({ now: FRI_AFTER_END });
    expect(result.rows).toBe(2);
    expect(fxAt("2026-06-05")).toBeCloseTo(910.29, 2);
    expect(fxAt("2026-06-06")).toBeNull();
  });

  it("never revises an existing row (write-once: the frozen value is the value history keeps)", async () => {
    insertFxRowsIfMissing([{ date: "2026-06-05", clpPerUsd: 908.0 }]);
    const result = await syncYahooFxUsdFromYahoo({ now: FRI_AFTER_END });
    expect(result.rows).toBe(1); // only 06-04 was missing
    expect(fxAt("2026-06-05")).toBeCloseTo(908.0, 2);
  });

  it("takes the due day from the chart quote when the daily series lags", async () => {
    mocks.fetchWithMeta.mockResolvedValueOnce({
      series: { dates: ["2026-06-04"], closes: [909.5] },
      meta: { regularMarketPrice: 910.7, regularMarketTime: Math.floor(FRI_AFTER_END.getTime() / 1000) },
    });
    const result = await syncYahooFxUsdFromYahoo({ now: FRI_AFTER_END });
    expect(result.used_meta_quote).toBe(true);
    expect(fxAt("2026-06-05")).toBeCloseTo(910.7, 2);
  });
});
