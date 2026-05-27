import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const staleSyncSources = vi.fn<() => string[]>(() => []);
const allSyncSourceStatuses = vi.fn(() => [] as { status: string; next_sync_imminent: boolean; next_sync: null }[]);
const runGlobalSyncAll = vi.fn(async () => 0);

vi.mock("./globalSyncStale.js", () => ({
  staleSyncSources: (...args: unknown[]) => staleSyncSources(...args),
  allSyncSourceStatuses: (...args: unknown[]) => allSyncSourceStatuses(...args),
}));

vi.mock("./globalSyncAll.js", () => ({
  runGlobalSyncAll: (...args: unknown[]) => runGlobalSyncAll(...args),
}));

vi.mock("./globalSyncState.js", () => ({
  loadGlobalSyncState: () => ({}),
}));

vi.mock("./rootDotenv.js", () => ({
  loadRootDotenv: () => {},
}));

vi.mock("./chileDate.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./chileDate.js")>();
  return {
    ...actual,
    chileWallClockNow: () => ({
      ymd: "2026-05-27",
      year: 2026,
      month: 5,
      day: 27,
      hour: 10,
      minute: 0,
      monthKey: "2026-05",
    }),
  };
});

import {
  getGlobalSyncSchedulerSnapshot,
  notifyGlobalSyncScheduler,
  startGlobalSyncScheduler,
  stopGlobalSyncScheduler,
} from "./globalSyncScheduler.js";

describe("globalSyncScheduler", () => {
  beforeEach(() => {
    stopGlobalSyncScheduler();
    vi.useFakeTimers({ now: new Date("2026-05-27T14:00:00Z") });
    staleSyncSources.mockReturnValue([]);
    allSyncSourceStatuses.mockReturnValue([]);
    runGlobalSyncAll.mockClear();
    runGlobalSyncAll.mockResolvedValue(0);
    process.env.GLOBAL_SYNC_ENABLED = "1";
    process.env.GLOBAL_SYNC_INTERVAL_MS = "60000";
  });

  afterEach(() => {
    stopGlobalSyncScheduler();
    vi.useRealTimers();
    delete process.env.GLOBAL_SYNC_INTERVAL_MS;
  });

  it("does not poll on a timer when all sources are fresh", async () => {
    allSyncSourceStatuses.mockReturnValue([
      {
        status: "ok",
        next_sync_imminent: false,
        next_sync: {
          ymd: "2026-05-27",
          hour: 23,
          minute: 55,
          timeZone: "America/Santiago" as const,
        },
      },
    ]);
    startGlobalSyncScheduler();
    await Promise.resolve();
    await Promise.resolve();
    expect(runGlobalSyncAll).not.toHaveBeenCalled();
    expect(getGlobalSyncSchedulerSnapshot().next_check_at).not.toBeNull();
  });

  it("starts polling immediately when a source is stale", async () => {
    staleSyncSources.mockReturnValue(["crypto_eod"]);
    startGlobalSyncScheduler();
    await vi.waitFor(() => expect(runGlobalSyncAll).toHaveBeenCalledTimes(1));
  });

  it("polls again on interval while still stale", async () => {
    staleSyncSources.mockReturnValue(["crypto_eod"]);
    startGlobalSyncScheduler();
    await vi.waitFor(() => expect(runGlobalSyncAll).toHaveBeenCalledTimes(1));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(runGlobalSyncAll).toHaveBeenCalledTimes(2);
  });

  it("stops polling and schedules wake when sources become fresh", async () => {
    staleSyncSources.mockImplementation(() =>
      runGlobalSyncAll.mock.calls.length === 0 ? ["crypto_eod"] : []
    );
    startGlobalSyncScheduler();
    await vi.waitFor(() => expect(runGlobalSyncAll).toHaveBeenCalledTimes(1));
    runGlobalSyncAll.mockClear();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(runGlobalSyncAll).not.toHaveBeenCalled();
  });

  it("notify starts polling when force-stale while idle", async () => {
    startGlobalSyncScheduler();
    await Promise.resolve();
    expect(runGlobalSyncAll).not.toHaveBeenCalled();
    staleSyncSources.mockReturnValue(["fintual"]);
    notifyGlobalSyncScheduler();
    await vi.waitFor(() => expect(runGlobalSyncAll).toHaveBeenCalledTimes(1));
  });
});
