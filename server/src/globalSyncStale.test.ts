import { describe, expect, it } from "vitest";
import type { ChileWallClock } from "./chileDate.js";
import type { GlobalSyncStateFile } from "./globalSyncState.js";
import {
  FINTUAL_PUBLISHER_LAG_MAX_POLL_AGE_MS,
  allSyncSourceStatuses,
  fintualPublisherLag,
  isFintualSyncStale,
  staleSyncSources,
} from "./globalSyncStale.js";

const cl: ChileWallClock = wallClock("2026-05-22", 20);

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
    const sunday = wallClock("2026-05-24", 20);
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
    const saturday = wallClock("2026-05-23", 20);
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
    const monday = wallClock("2026-05-25", 20);
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

/**
 * Publisher lag vs our own staleness. The 2026-09-15 shape: Monday's evening poll expected the
 * 14th's cuota, Fintual had only published the 13th, and the poll kept running every 15 minutes
 * into Tuesday — stale by the carry rule, but nothing on our side was behind.
 */
describe("fintualPublisherLag", () => {
  const tuesdayMorning = wallClock("2026-09-15", 11);
  const nowMs = Date.parse("2026-09-15T14:30:00Z");
  const waitingOnMonday: GlobalSyncStateFile = {
    fintualLastCheckYmd: "2026-09-14",
    fintualLastAppliedYmd: "2026-09-14",
    fintualLastPublishYmd: "2026-09-13",
    fintualLastAppliedPublishYmd: "2026-09-13",
    fintualEveningSettledYmd: "2026-09-13",
    fintualLastCheckSig: "sig",
    fintualLastAppliedSig: "sig",
  };

  it("classifies a recent poll that is only missing the publisher's next day as publisher lag", () => {
    expect(isFintualSyncStale(tuesdayMorning, waitingOnMonday)).toBe(true);
    const lag = fintualPublisherLag(tuesdayMorning, waitingOnMonday, {
      lastCheckedAt: "2026-09-15T14:13:00Z",
      nowMs,
    });
    expect(lag).toEqual({
      expected_ymd: "2026-09-14",
      published_ymd: "2026-09-13",
      last_checked_at: "2026-09-15T14:13:00Z",
    });
  });

  it("is our staleness when the poll itself is old, never ran, or was forced by hand", () => {
    const stalePoll = new Date(nowMs - FINTUAL_PUBLISHER_LAG_MAX_POLL_AGE_MS - 1_000).toISOString();
    expect(fintualPublisherLag(tuesdayMorning, waitingOnMonday, { lastCheckedAt: stalePoll, nowMs })).toBeNull();
    expect(fintualPublisherLag(tuesdayMorning, waitingOnMonday, { lastCheckedAt: null, nowMs })).toBeNull();
    const forced: GlobalSyncStateFile = { ...waitingOnMonday, userForcedStale: ["fintual"] };
    expect(
      fintualPublisherLag(tuesdayMorning, forced, { lastCheckedAt: "2026-09-15T14:13:00Z", nowMs })
    ).toBeNull();
  });

  it("is our staleness when the API has published but our applied state disagrees", () => {
    // Same-day publish, signatures differ: the DB did not take the NAV — nothing to wait for.
    const mismatch: GlobalSyncStateFile = {
      ...waitingOnMonday,
      fintualLastPublishYmd: "2026-09-14",
      fintualLastAppliedPublishYmd: "2026-09-14",
      fintualLastCheckSig: "new",
      fintualLastAppliedSig: "old",
    };
    expect(isFintualSyncStale(tuesdayMorning, mismatch)).toBe(true);
    expect(
      fintualPublisherLag(tuesdayMorning, mismatch, { lastCheckedAt: "2026-09-15T14:13:00Z", nowMs })
    ).toBeNull();
  });

  it("keeps the source in `stale` (the scheduler still polls) but out of the dimming list", () => {
    const rows = allSyncSourceStatuses(tuesdayMorning, waitingOnMonday, {
      bcentralConfigured: true,
      fintualLastCheckedAt: "2026-09-15T14:13:00Z",
      nowMs,
    });
    const fintual = rows.find((r) => r.source === "fintual");
    expect(fintual?.stale).toBe(true);
    expect(fintual?.status).toBe("stale");
    expect(fintual?.publisher_lag?.expected_ymd).toBe("2026-09-14");
    const behind = rows.filter((r) => r.stale && r.publisher_lag == null).map((r) => r.source);
    expect(behind).not.toContain("fintual");

    const missedPoll = allSyncSourceStatuses(tuesdayMorning, waitingOnMonday, {
      bcentralConfigured: true,
      fintualLastCheckedAt: null,
      nowMs,
    }).find((r) => r.source === "fintual");
    expect(missedPoll?.publisher_lag).toBeNull();
  });
});
