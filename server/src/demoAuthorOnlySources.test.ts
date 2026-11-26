import { afterEach, describe, expect, it } from "vitest";
import { benchmarkFundSeriesHasData } from "./benchmarkLevels.js";
import { syncStatusPayload } from "./globalSyncStale.js";
import { DEMO_SYNC_DISABLED_SOURCES } from "./syncSourceIds.js";

/** The demo carries nothing of the author's Fintual setup: its sync sources are not listed there. */
describe("author-only sync sources", () => {
  const before = process.env.DEMO_MODE;
  afterEach(() => {
    if (before === undefined) delete process.env.DEMO_MODE;
    else process.env.DEMO_MODE = before;
  });

  it("are listed on a personal instance and left out of the demo's status list", () => {
    delete process.env.DEMO_MODE;
    const personal = new Set(syncStatusPayload().sources.map((r) => r.source));
    for (const s of DEMO_SYNC_DISABLED_SOURCES) expect(personal.has(s)).toBe(true);

    process.env.DEMO_MODE = "1";
    const demo = syncStatusPayload();
    for (const s of DEMO_SYNC_DISABLED_SOURCES) expect(demo.sources.some((r) => r.source === s)).toBe(false);
    // The sources the demo does run are still there.
    expect(demo.sources.some((r) => r.source === "stocks_nyse")).toBe(true);
  });
});

describe("a fund benchmark", () => {
  it("has nothing to compare with while its series holds no value", () => {
    expect(benchmarkFundSeriesHasData("vitest_no_such_series")).toBe(false);
  });
});
