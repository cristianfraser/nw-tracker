import { describe, expect, it } from "vitest";
import type { ChileWallClock } from "./chileDate.js";
import type { GlobalSyncStateFile } from "./globalSyncState.js";
import { allSyncSourceStatuses, isFintualSyncStale, staleSyncSources } from "./globalSyncStale.js";

const cl: ChileWallClock = {
  ymd: "2026-05-22",
  hour: 20,
  minute: 0,
  day: 22,
  monthKey: "2026-05",
};

describe("userForcedStale", () => {
  it("marks an ok source stale in status and scheduler lists", () => {
    const state: GlobalSyncStateFile = {
      unoLastSpotYmd: cl.ymd,
      fintualEveningSettledYmd: cl.ymd,
      fintualLastCheckYmd: cl.ymd,
      fintualLastPublishYmd: cl.ymd,
      fintualLastAppliedPublishYmd: cl.ymd,
      fintualLastCheckSig: "sig",
      fintualLastAppliedSig: "sig",
      equityEodLastNySessionYmd: cl.ymd,
      equityEodLastCryptoUtcYmd: cl.ymd,
      userForcedStale: ["fintual"],
    };
    const rows = allSyncSourceStatuses(cl, state, { bcentralConfigured: true });
    const fintual = rows.find((r) => r.source === "fintual");
    expect(fintual?.status).toBe("stale");
    expect(fintual?.stale).toBe(true);
    expect(staleSyncSources(cl, state, { bcentralConfigured: true })).toContain("fintual");
  });
});

describe("isFintualSyncStale publish advance", () => {
  it("stays stale when poll publish is ahead of last applied", () => {
    const state: GlobalSyncStateFile = {
      fintualEveningSettledYmd: cl.ymd,
      fintualLastCheckYmd: cl.ymd,
      fintualLastPublishYmd: "2026-05-24",
      fintualLastAppliedPublishYmd: cl.ymd,
      fintualLastCheckSig: "sig",
      fintualLastAppliedSig: "sig",
    };
    expect(isFintualSyncStale(cl, state)).toBe(true);
  });
});
