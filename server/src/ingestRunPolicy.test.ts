import { describe, expect, it } from "vitest";
import type { SantanderState } from "nw-tracker-contracts";
import {
  decideAfpUnoFetch,
  decidePayslipsRun,
  decideIngestRun,
  decideSantanderFetch,
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

describe("decideSantanderFetch", () => {
  // 2026-09-29 (Tuesday) 22:00 Chile = 2026-09-30T01:00Z; 2026-09-30 is the month's last business day.
  const state = (over: Partial<SantanderState> = {}): SantanderState => ({
    last_attempt_at: "2026-09-30T01:00:30.000Z",
    last_success_at: "2026-09-29T01:01:00.000Z",
    login_latched: false,
    last_catch_up_attempt_at: null,
    last_payday_attempt_ymd: null,
    ...over,
  });
  const base = { lastCatchUpAttemptAt: null, lastPaydayAttemptYmd: null };

  it("waits for the first report before deciding anything", () => {
    expect(decideSantanderFetch({ ...base, now: at("2026-09-30T02:30:00Z"), state: null })).toBeNull();
  });

  it("retries a failed nightly fetch once the slot's grace has passed, once", () => {
    // 22:20 Chile: the nightly still has its chance.
    expect(decideSantanderFetch({ ...base, now: at("2026-09-30T01:20:00Z"), state: state() })).toBeNull();
    expect(decideSantanderFetch({ ...base, now: at("2026-09-30T01:40:00Z"), state: state() })).toMatchObject({
      mode: "catch-up",
    });
    expect(
      decideSantanderFetch({ ...base, now: at("2026-09-30T02:40:00Z"), state: state(), lastCatchUpAttemptAt: at("2026-09-30T01:40:00Z") })
    ).toBeNull();
    expect(
      decideSantanderFetch({ ...base, now: at("2026-09-30T02:40:00Z"), state: state({ last_catch_up_attempt_at: "2026-09-30T01:40:00.000Z" }) })
    ).toBeNull();
  });

  it("does not retry after a successful fetch, a latched login, or an attempt minutes ago", () => {
    const now = at("2026-09-30T01:40:00Z");
    expect(decideSantanderFetch({ ...base, now, state: state({ last_success_at: "2026-09-30T01:02:00.000Z" }) })).toBeNull();
    expect(decideSantanderFetch({ ...base, now, state: state({ login_latched: true }) })).toBeNull();
    expect(decideSantanderFetch({ ...base, now, state: state({ last_attempt_at: "2026-09-30T01:20:00.000Z" }) })).toBeNull();
  });

  it("fetches on payday morning from 09:00, once", () => {
    const fetchedLastNight = state({ last_success_at: "2026-09-30T01:02:00.000Z" });
    // 08:30 Chile: too early; 09:30: due; tried already today: not again.
    expect(decideSantanderFetch({ ...base, now: at("2026-09-30T11:30:00Z"), state: fetchedLastNight })).toBeNull();
    expect(decideSantanderFetch({ ...base, now: at("2026-09-30T12:30:00Z"), state: fetchedLastNight })).toMatchObject({
      mode: "payday",
    });
    expect(
      decideSantanderFetch({ ...base, now: at("2026-09-30T13:30:00Z"), state: fetchedLastNight, lastPaydayAttemptYmd: "2026-09-30" })
    ).toBeNull();
    // Tried by the shell poll before the switch: its marker counts.
    expect(
      decideSantanderFetch({ ...base, now: at("2026-09-30T13:30:00Z"), state: { ...fetchedLastNight, last_payday_attempt_ymd: "2026-09-30" } })
    ).toBeNull();
    // Any other day: nothing.
    expect(
      decideSantanderFetch({ ...base, now: at("2026-09-29T12:30:00Z"), state: state({ last_success_at: "2026-09-29T01:02:00.000Z" }) })
    ).toBeNull();
  });
});

describe("decideAfpUnoFetch", () => {
  // Chile is UTC−3 from 2026-09-06: 22:00 Chile on day D = 01:00Z on D+1.
  const nightOf = (ymd: string) => new Date(new Date(`${ymd}T01:00:00Z`).getTime() + 86_400_000);

  it("reads before the 10th to check the balance", () => {
    expect(decideAfpUnoFetch({ now: nightOf("2026-10-09"), lastCleanImportAt: null }).reason).toBe("nightly balance check against the website");
  });

  it("reads every night from the 10th through the month's end until a clean import", () => {
    expect(decideAfpUnoFetch({ now: nightOf("2026-10-10"), lastCleanImportAt: null })?.reason).toBe("no clean import since 2026-10-10");
    expect(decideAfpUnoFetch({ now: nightOf("2026-10-31"), lastCleanImportAt: nightOf("2026-09-12") })).not.toBeNull();
  });

  it("after a clean import only checks the balance until the next 10th", () => {
    const imported = nightOf("2026-10-12");
    const check = "nightly balance check against the website";
    expect(decideAfpUnoFetch({ now: nightOf("2026-10-13"), lastCleanImportAt: imported }).reason).toBe(check);
    expect(decideAfpUnoFetch({ now: nightOf("2026-11-09"), lastCleanImportAt: imported }).reason).toBe(check);
    expect(decideAfpUnoFetch({ now: nightOf("2026-11-10"), lastCleanImportAt: imported }).reason).toBe("no clean import since 2026-11-10");
  });
});

describe("decidePayslipsRun", () => {
  // Chile is UTC−3 from 2026-09-06: 22:00 Chile on day D = 01:00Z on D+1.
  const nightOf = (ymd: string) => new Date(new Date(`${ymd}T01:00:00Z`).getTime() + 86_400_000);

  it("reads the portal from the 1st through the 15th while last month's payslip is missing", () => {
    const latest = { period: "2026-09", paired: true };
    expect(decidePayslipsRun({ now: nightOf("2026-11-01"), latest })).toEqual({ fetch: true, reason: "no payslip for 2026-10 yet" });
    expect(decidePayslipsRun({ now: nightOf("2026-11-15"), latest })?.fetch).toBe(true);
    expect(decidePayslipsRun({ now: nightOf("2026-11-16"), latest })).toBeNull();
    expect(decidePayslipsRun({ now: nightOf("2026-11-01"), latest: null })?.fetch).toBe(true);
  });

  it("reads January's for December across the year", () => {
    expect(decidePayslipsRun({ now: nightOf("2027-01-03"), latest: { period: "2026-11", paired: true } })?.reason).toBe(
      "no payslip for 2026-12 yet"
    );
  });

  it("imports alone while the newest payslip waits for its deposit, then stops", () => {
    expect(decidePayslipsRun({ now: nightOf("2026-10-06"), latest: { period: "2026-09", paired: false } })).toEqual({
      fetch: false,
      reason: "payslip 2026-09 has no deposit paired yet",
    });
    expect(decidePayslipsRun({ now: nightOf("2026-10-06"), latest: { period: "2026-09", paired: true } })).toBeNull();
    // An old unpaired payslip (the 2017 ones no deposit pays) never keeps the import running.
    expect(decidePayslipsRun({ now: nightOf("2026-10-20"), latest: { period: "2026-08", paired: false } })).toBeNull();
  });
});
