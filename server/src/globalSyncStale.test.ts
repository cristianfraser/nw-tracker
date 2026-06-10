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

describe("isFintualSyncStale non-business block", () => {
  it("is stale on Sunday evening after Friday sync (weekend block ends Sunday)", () => {
    const sunday: ChileWallClock = {
      ymd: "2026-05-24",
      hour: 20,
      minute: 0,
      day: 24,
      monthKey: "2026-05",
    };
    const state: GlobalSyncStateFile = {
      fintualEveningSettledYmd: "2026-05-22",
      fintualLastCheckYmd: "2026-05-22",
      fintualLastPublishYmd: "2026-05-24",
      fintualLastAppliedPublishYmd: "2026-05-24",
      fintualLastCheckSig: "sig",
      fintualLastAppliedSig: "sig",
    };
    expect(isFintualSyncStale(sunday, state)).toBe(true);
  });

  it("is not stale on Saturday evening (block not ended)", () => {
    const saturday: ChileWallClock = {
      ymd: "2026-05-23",
      hour: 20,
      minute: 0,
      day: 23,
      monthKey: "2026-05",
    };
    const state: GlobalSyncStateFile = {
      fintualEveningSettledYmd: "2026-05-22",
      fintualLastCheckYmd: "2026-05-22",
      fintualLastPublishYmd: "2026-05-24",
      fintualLastAppliedPublishYmd: "2026-05-24",
      fintualLastCheckSig: "sig",
      fintualLastAppliedSig: "sig",
    };
    expect(isFintualSyncStale(saturday, state)).toBe(false);
  });
});

describe("isFintualSyncStale publish lag", () => {
  it("stays stale after a no-change poll when API publish is before poll day", () => {
    const monday: ChileWallClock = {
      ymd: "2026-05-25",
      hour: 20,
      minute: 0,
      day: 25,
      monthKey: "2026-05",
    };
    const state: GlobalSyncStateFile = {
      fintualLastCheckYmd: "2026-05-25",
      fintualLastPublishYmd: "2026-05-24",
      fintualLastAppliedPublishYmd: "2026-05-24",
      fintualLastCheckSig: "sig",
      fintualLastAppliedSig: "sig",
      fintualEveningSettledYmd: "2026-05-22",
    };
    expect(isFintualSyncStale(monday, state)).toBe(true);
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

function wallClock(ymd: string, hour: number): ChileWallClock {
  const [ys, ms, ds] = ymd.split("-");
  return {
    ymd,
    year: Number(ys),
    month: Number(ms),
    day: Number(ds),
    hour,
    minute: 0,
    monthKey: ymd.slice(0, 7),
  };
}

/** Evening publish-lag state carried from Tuesday night into Wednesday morning. */
const tuesdayEveningPublishLagState: GlobalSyncStateFile = {
  fintualLastCheckYmd: "2026-06-09",
  fintualLastPublishYmd: "2026-06-08",
  fintualLastAppliedPublishYmd: "2026-06-08",
  fintualLastCheckSig: "sig",
  fintualLastAppliedSig: "sig",
  fintualEveningSettledYmd: "2026-06-05",
};

describe("isFintualSyncStale prior evening carry-over", () => {
  it("stays stale before 18:00 when prior evening poll had publish lag", () => {
    const wedMorning = wallClock("2026-06-10", 8);
    expect(isFintualSyncStale(wedMorning, tuesdayEveningPublishLagState)).toBe(true);
  });

  it("is not stale on Saturday morning after a settled Friday evening", () => {
    const saturdayMorning = wallClock("2026-06-06", 10);
    const state: GlobalSyncStateFile = {
      fintualEveningSettledYmd: "2026-06-05",
      fintualLastCheckYmd: "2026-06-05",
      fintualLastPublishYmd: "2026-06-05",
      fintualLastAppliedPublishYmd: "2026-06-05",
      fintualLastCheckSig: "sig",
      fintualLastAppliedSig: "sig",
    };
    expect(isFintualSyncStale(saturdayMorning, state)).toBe(false);
  });

  it("includes fintual in scheduler list before 18:00 on carry-over", () => {
    const wedMorning = wallClock("2026-06-10", 8);
    expect(staleSyncSources(wedMorning, tuesdayEveningPublishLagState, { bcentralConfigured: false })).toContain(
      "fintual"
    );
  });

  it("shows carry-over stale in UI as imminent (scheduler polls now)", () => {
    const wedMorning = wallClock("2026-06-10", 8);
    const rows = allSyncSourceStatuses(wedMorning, tuesdayEveningPublishLagState, {
      bcentralConfigured: false,
    });
    const fintual = rows.find((r) => r.source === "fintual");
    expect(fintual?.stale).toBe(true);
    expect(fintual?.status).toBe("stale");
    expect(fintual?.next_sync_imminent).toBe(true);
    expect(fintual?.next_sync).toBeNull();
  });

  it("is not stale when poll day is caught up but fintualEveningSettledYmd lags", () => {
    const wedMorning = wallClock("2026-06-10", 8);
    const sig =
      "1164983:18425830.92|16749:44773588.22|2859:10526623.06|78515:20154561.74";
    const state: GlobalSyncStateFile = {
      fintualLastCheckYmd: "2026-06-09",
      fintualLastPublishYmd: "2026-06-09",
      fintualLastAppliedPublishYmd: "2026-06-09",
      fintualLastCheckSig: sig,
      fintualLastAppliedSig: sig,
      fintualEveningSettledYmd: "2026-05-27",
    };
    expect(isFintualSyncStale(wedMorning, state)).toBe(false);
    expect(staleSyncSources(wedMorning, state, { bcentralConfigured: false })).not.toContain("fintual");
  });
});
