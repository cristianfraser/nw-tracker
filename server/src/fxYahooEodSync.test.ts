import { afterEach, describe, expect, it, vi } from "vitest";
import { db } from "./db.js";
import {
  isYahooFxEodSyncWindow,
  isYahooFxUsdStale,
  syncYahooFxUsdFromYahoo,
  yahooFxUsdCaughtUp,
  yahooFxUsdSyncDue,
} from "./fxYahooEodSync.js";
import { chileWallClockAt } from "./chileDate.js";
import { upsertFxRows } from "./sbifSyncDb.js";

vi.mock("./equityYahooEod.js", () => ({
  fetchYahooRecentDailyCloses: vi.fn(async () => ({
    dates: ["2026-06-05", "2026-06-06"],
    closes: [910.29, 911.0],
  })),
}));

afterEach(() => {
  db.exec("DELETE FROM fx_daily");
  vi.clearAllMocks();
});

describe("isYahooFxEodSyncWindow", () => {
  it("is false before 17:30 Chile", () => {
    const cl = chileWallClockAt(new Date("2026-06-05T20:00:00.000Z"));
    expect(cl.hour).toBeLessThan(17);
    expect(isYahooFxEodSyncWindow(cl)).toBe(false);
  });

  it("is true at 17:30 Chile on a trading day", () => {
    const cl = chileWallClockAt(new Date("2026-06-05T21:30:00.000Z"));
    expect(isYahooFxEodSyncWindow(cl)).toBe(true);
  });
});

describe("yahooFxUsdSyncDue", () => {
  it("returns null before 17:30 Chile", () => {
    expect(yahooFxUsdSyncDue(new Date("2026-06-05T20:00:00.000Z"))).toBeNull();
  });

  it("returns NYSE session after 17:30 Chile", () => {
    const due = yahooFxUsdSyncDue(new Date("2026-06-05T21:30:00.000Z"));
    expect(due).toBe("2026-06-05");
  });
});

describe("yahooFxUsdCaughtUp", () => {
  it("is true when fx_daily has the due session", () => {
    upsertFxRows([{ date: "2026-06-05", clpPerUsd: 910.29 }], false);
    expect(yahooFxUsdCaughtUp("2026-06-05")).toBe(true);
    expect(yahooFxUsdCaughtUp("2026-06-06")).toBe(false);
  });
});

describe("isYahooFxUsdStale", () => {
  it("is stale after 17:30 Chile when due session missing", () => {
    const now = new Date("2026-06-05T21:30:00.000Z");
    expect(isYahooFxUsdStale({ now })).toBe(true);
    upsertFxRows([{ date: "2026-06-05", clpPerUsd: 910.29 }], false);
    expect(isYahooFxUsdStale({ now })).toBe(false);
  });
});

describe("syncYahooFxUsdFromYahoo", () => {
  it("upserts recent Yahoo bars after 17:30 Chile", async () => {
    const now = new Date("2026-06-05T21:30:00.000Z");
    const result = await syncYahooFxUsdFromYahoo({ now });
    expect(result.skipped).toBeUndefined();
    expect(result.rows).toBe(2);
    const row = db
      .prepare(`SELECT clp_per_usd FROM fx_daily WHERE date = ?`)
      .get("2026-06-05") as { clp_per_usd: number };
    expect(row.clp_per_usd).toBeCloseTo(910.29, 2);
  });

  it("skips before 17:30 Chile unless forced", async () => {
    const now = new Date("2026-06-05T20:00:00.000Z");
    const result = await syncYahooFxUsdFromYahoo({ now });
    expect(result.skipped).toBe("before_yahoo_fx_sync_window");
    expect(result.rows).toBe(0);
  });
});
