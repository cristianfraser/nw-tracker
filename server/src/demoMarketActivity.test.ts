import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEMO_MARKET_IDLE_MS,
  demoMarketAwake,
  noteDemoMarketActivity,
  onDemoMarketWake,
  resetDemoMarketActivityForTest,
} from "./demoMarketActivity.js";
import { allSyncSourceStatuses, DEMO_SYNC_DISABLED_SOURCES } from "./globalSyncStale.js";
import { loadGlobalSyncState } from "./globalSyncState.js";
import { chileWallClockAt } from "./chileDate.js";
import { closesThrough, withDemoMarketRetries } from "./demoData/demoRealMarket.js";

afterEach(() => {
  delete process.env.DEMO_MODE;
  resetDemoMarketActivityForTest();
});

describe("demo market wake gate", () => {
  it("is always awake outside the demo", () => {
    expect(demoMarketAwake(0)).toBe(true);
  });

  it("sleeps until a visitor's request, wakes listeners once, sleeps again after the idle window", () => {
    process.env.DEMO_MODE = "1";
    const wake = vi.fn();
    onDemoMarketWake(wake);
    const t0 = 1_000_000;
    expect(demoMarketAwake(t0)).toBe(false);
    noteDemoMarketActivity(t0);
    noteDemoMarketActivity(t0 + 60_000);
    expect(wake).toHaveBeenCalledTimes(1);
    expect(demoMarketAwake(t0 + 60_000 + DEMO_MARKET_IDLE_MS - 1)).toBe(true);
    expect(demoMarketAwake(t0 + 60_000 + DEMO_MARKET_IDLE_MS)).toBe(false);
    noteDemoMarketActivity(t0 + 60_000 + DEMO_MARKET_IDLE_MS + 5);
    expect(wake).toHaveBeenCalledTimes(2);
  });
});

describe("demo sync sources", () => {
  it("shows the author-only sources as not configured on the demo", () => {
    process.env.DEMO_MODE = "1";
    const cl = chileWallClockAt(new Date());
    const rows = allSyncSourceStatuses(cl, loadGlobalSyncState(), { fintualLastCheckedAt: null });
    for (const source of DEMO_SYNC_DISABLED_SOURCES) {
      expect(rows.find((r) => r.source === source)).toMatchObject({ status: "disabled", stale: false });
    }
  });
});

describe("demo real market helpers", () => {
  it("keeps closes through the given day", () => {
    expect(closesThrough({ dates: ["2026-10-29", "2026-10-30", "2026-10-31"], closes: [1, 2, 3] }, "2026-10-30")).toEqual({
      dates: ["2026-10-29", "2026-10-30"],
      closes: [1, 2],
    });
  });

  it("retries a failing source and gives up after the last delay", async () => {
    const sleep = vi.fn(async () => {});
    let calls = 0;
    const ok = await withDemoMarketRetries(
      "x",
      async () => {
        calls += 1;
        if (calls < 3) throw new Error("down");
        return "up";
      },
      { delaysMs: [1, 2, 3], sleep, log: () => {} }
    );
    expect(ok).toBe("up");
    expect(sleep).toHaveBeenCalledTimes(2);
    await expect(
      withDemoMarketRetries("y", async () => Promise.reject(new Error("down")), { delaysMs: [1], sleep, log: () => {} })
    ).rejects.toThrow("y still failing after 2 attempts");
  });
});
