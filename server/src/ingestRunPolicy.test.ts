import { describe, expect, it } from "vitest";
import {
  decideIngestRun,
  hourlySlotAtOrBefore,
  nightlySlotAtOrBefore,
  type IngestSchedulerInputs,
} from "./ingestRunPolicy.js";

/** 2026-09-30 is UTC−3 in Chile (spring-forward was 2026-09-06): 22:00 Chile = 01:00Z next day. */
const at = (iso: string) => new Date(iso);
const NIGHTLY_0930 = at("2026-10-01T01:00:00Z"); // 2026-09-30 22:00 Chile
const NIGHTLY_0929 = at("2026-09-30T01:00:00Z"); // 2026-09-29 22:00 Chile

function inputs(over: Partial<IngestSchedulerInputs>): IngestSchedulerInputs {
  return {
    now: at("2026-09-30T18:10:00Z"),
    lastNightlySlot: NIGHTLY_0929,
    lastHourlySlot: at("2026-09-30T17:30:00Z"),
    lastDailyRunAt: at("2026-09-30T01:20:00Z"),
    inFlight: null,
    ...over,
  };
}

describe("slots", () => {
  it("finds the latest 22:00 Chile at or before now", () => {
    expect(nightlySlotAtOrBefore(at("2026-09-30T18:10:00Z"))).toEqual(NIGHTLY_0929);
    expect(nightlySlotAtOrBefore(NIGHTLY_0930)).toEqual(NIGHTLY_0930);
    expect(nightlySlotAtOrBefore(at("2026-10-01T00:59:59Z"))).toEqual(NIGHTLY_0929);
    // Winter time (UTC−4): 22:00 Chile = 02:00Z.
    expect(nightlySlotAtOrBefore(at("2026-07-15T12:00:00Z"))).toEqual(at("2026-07-15T02:00:00Z"));
  });

  it("finds the latest :30", () => {
    expect(hourlySlotAtOrBefore(at("2026-09-30T18:10:00Z"))).toEqual(at("2026-09-30T17:30:00Z"));
    expect(hourlySlotAtOrBefore(at("2026-09-30T18:30:00Z"))).toEqual(at("2026-09-30T18:30:00Z"));
    expect(hourlySlotAtOrBefore(at("2026-10-01T00:05:00Z"))).toEqual(at("2026-09-30T23:30:00Z"));
  });
});

describe("decideIngestRun", () => {
  it("does nothing between slots", () => {
    expect(decideIngestRun(inputs({}))).toEqual({ action: "idle" });
  });

  it("asks for the hourly poll at :30", () => {
    expect(decideIngestRun(inputs({ now: at("2026-09-30T18:30:05Z") }))).toMatchObject({
      action: "request",
      kind: "hourly",
      slot: at("2026-09-30T18:30:00Z"),
      reason: ":30 slot, on time",
    });
  });

  it("asks for the nightly at 22:00, ahead of the hourly", () => {
    expect(
      decideIngestRun(inputs({ now: at("2026-10-01T01:00:20Z"), lastHourlySlot: at("2026-09-30T23:30:00Z") }))
    ).toMatchObject({ action: "request", kind: "nightly", slot: NIGHTLY_0930, reason: "22:00 slot, on time" });
  });

  it("runs a slept-through 22:00 on wake, once", () => {
    const wake = at("2026-10-01T07:21:00Z"); // 04:21 Chile
    const d = decideIngestRun(inputs({ now: wake, lastHourlySlot: at("2026-09-30T23:30:00Z") }));
    expect(d).toMatchObject({ action: "request", kind: "nightly", slot: NIGHTLY_0930 });
    expect(d.action === "request" && d.reason).toMatch(/381 min late/);
    // Once that slot has a row, the hour's poll is next — and skipped while the nightly runs.
    expect(
      decideIngestRun(inputs({ now: wake, lastNightlySlot: NIGHTLY_0930, lastHourlySlot: at("2026-09-30T23:30:00Z"), inFlight: { kind: "nightly" } }))
    ).toMatchObject({ action: "skip", kind: "hourly", slot: at("2026-10-01T06:30:00Z") });
  });

  it("counts a daily run recorded after the slot as its answer (a LaunchAgent or manual run)", () => {
    expect(
      decideIngestRun(inputs({ now: at("2026-10-01T01:40:00Z"), lastNightlySlot: null, lastDailyRunAt: at("2026-10-01T01:12:00Z"), lastHourlySlot: at("2026-10-01T01:30:00Z") }))
    ).toEqual({ action: "idle" });
  });

  it("skips the slot right behind a run that finished less than an hour ago", () => {
    expect(
      decideIngestRun(inputs({ now: at("2026-10-01T01:00:30Z"), lastDailyRunAt: at("2026-10-01T00:40:00Z") }))
    ).toMatchObject({ action: "skip", kind: "nightly", slot: NIGHTLY_0930, reason: "a daily run finished 21 min ago" });
    // An afternoon run does not cancel the evening's (2026-09-25).
    expect(
      decideIngestRun(inputs({ now: at("2026-10-01T01:00:30Z"), lastDailyRunAt: at("2026-09-30T15:55:00Z") }))
    ).toMatchObject({ action: "request", kind: "nightly" });
  });

  it("makes the nightly wait for a run in flight", () => {
    expect(
      decideIngestRun(inputs({ now: at("2026-10-01T01:00:30Z"), inFlight: { kind: "hourly" } }))
    ).toMatchObject({ action: "wait", kind: "nightly", reason: "a hourly run is in flight" });
  });

  it("starts with the latest hourly slot when no hourly has run yet", () => {
    expect(decideIngestRun(inputs({ lastHourlySlot: null }))).toMatchObject({
      action: "request",
      kind: "hourly",
      slot: at("2026-09-30T17:30:00Z"),
    });
  });
});
