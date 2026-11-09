import { describe, expect, it } from "vitest";
import type { SantanderState } from "nw-tracker-contracts";
import {
  decideAfcFetch,
  decideMortgageSheetRun,
  decidePayslipsRun,
  decideIngestRun,
  decideSantanderBalancePoll,
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
    // Once that slot is queued, the hour's poll is next (it waits in the queue behind the nightly).
    expect(
      decideIngestRun(inputs({ now: wake, lastNightlySlot: NIGHTLY_0930, lastHourlySlot: at("2026-09-30T23:30:00Z") }))
    ).toMatchObject({ action: "request", kind: "hourly", slot: at("2026-10-01T06:30:00Z") });
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

  it("starts with the latest hourly slot when no hourly has run yet", () => {
    expect(decideIngestRun(inputs({ lastHourlySlot: null }))).toMatchObject({
      action: "request",
      kind: "hourly",
      slot: at("2026-09-30T17:30:00Z"),
    });
  });
});

describe("decideSantanderBalancePoll", () => {
  // 2026-09-30 is UTC−3 in Chile: 22:00 Chile = 01:00Z next day.
  const state = (over: Partial<SantanderState> = {}): SantanderState => ({
    last_attempt_at: "2026-09-30T14:30:30.000Z",
    last_success_at: "2026-09-30T01:01:00.000Z",
    login_latched: false,
    ...over,
  });

  it("polls every hour, before the first report too", () => {
    expect(decideSantanderBalancePoll({ now: at("2026-09-30T15:30:00Z"), state: state() })).toMatchObject({ mode: "balance-poll" });
    expect(decideSantanderBalancePoll({ now: at("2026-09-30T15:30:00Z"), state: null })).toMatchObject({ mode: "balance-poll" });
  });

  it("skips a latched login and an attempt minutes ago", () => {
    const now = at("2026-09-30T15:30:00Z");
    expect(decideSantanderBalancePoll({ now, state: state({ login_latched: true }) })).toBeNull();
    expect(decideSantanderBalancePoll({ now, state: state({ last_attempt_at: "2026-09-30T15:00:00.000Z" }) })).toBeNull();
  });

  it("leaves the 22:00 slot clear: no poll at 21:30, none at 22:30 behind the nightly's own login", () => {
    expect(decideSantanderBalancePoll({ now: at("2026-10-01T00:30:00Z"), state: state() })).toBeNull();
    expect(decideSantanderBalancePoll({ now: at("2026-09-30T23:30:00Z"), state: state() })).toMatchObject({ mode: "balance-poll" });
    const nightly = state({ last_attempt_at: "2026-10-01T01:00:40.000Z" });
    expect(decideSantanderBalancePoll({ now: at("2026-10-01T01:30:00Z"), state: nightly })).toBeNull();
    expect(decideSantanderBalancePoll({ now: at("2026-10-01T02:30:00Z"), state: nightly })).toMatchObject({ mode: "balance-poll" });
  });
});


describe("decideMortgageSheetRun", () => {
  const at = (ymd: string, hourChile = 12) => new Date(`${ymd}T${String(hourChile + 3).padStart(2, "0")}:00:00Z`); // Chile UTC−3

  it("is stale from the 11th until a cuota dated in the cycle is in the ledger", () => {
    const paidSept = "2026-09-11";
    expect(decideMortgageSheetRun({ now: at("2026-10-10"), latestCuotaPaidOn: paidSept })).toBeNull();
    expect(decideMortgageSheetRun({ now: at("2026-10-11"), latestCuotaPaidOn: paidSept })).toEqual({
      reason: "no mortgage cuota in the ledger since 2026-10-11",
    });
    expect(decideMortgageSheetRun({ now: at("2026-10-25"), latestCuotaPaidOn: paidSept })?.reason).toContain("2026-10-11");
    expect(decideMortgageSheetRun({ now: at("2026-10-11"), latestCuotaPaidOn: "2026-10-11" })).toBeNull();
    expect(decideMortgageSheetRun({ now: at("2026-11-05"), latestCuotaPaidOn: "2026-10-20" })).toBeNull();
    expect(decideMortgageSheetRun({ now: at("2026-11-11"), latestCuotaPaidOn: "2026-10-20" })).not.toBeNull();
  });

  it("stays stale while a cuota is paid late, across the year, and with an empty ledger", () => {
    expect(decideMortgageSheetRun({ now: at("2026-11-15"), latestCuotaPaidOn: "2026-09-11" })?.reason).toContain("2026-11-11");
    expect(decideMortgageSheetRun({ now: at("2027-01-05"), latestCuotaPaidOn: "2026-11-11" })?.reason).toContain("2026-12-11");
    expect(decideMortgageSheetRun({ now: at("2027-01-05"), latestCuotaPaidOn: "2026-12-15" })).toBeNull();
    expect(decideMortgageSheetRun({ now: at("2026-10-11"), latestCuotaPaidOn: null })).not.toBeNull();
  });
});

describe("decideAfcFetch", () => {
  /** 22:00 Chile (UTC−3) of the given day. */
  const nightOf = (ymd: string) => new Date(new Date(`${ymd}T01:00:00Z`).getTime() + 86_400_000);
  it("reads from the 14th of the month after a payroll month until its contribution is in the ledger", () => {
    const pending = { latestSalaryPayslipPeriod: "2026-09", latestContributionPeriod: "2026-04" };
    expect(decideAfcFetch({ now: nightOf("2026-10-13"), ...pending })).toBeNull();
    expect(decideAfcFetch({ now: nightOf("2026-10-14"), ...pending })).toEqual({
      reason: "no AFC contribution for 2026-09 in the ledger yet (payslip on file, window from 2026-10-14)",
      expected_period: "2026-09",
      overdue: false,
    });
    expect(decideAfcFetch({ now: nightOf("2026-10-31"), ...pending })?.overdue).toBe(false);
    const late = decideAfcFetch({ now: nightOf("2026-11-01"), ...pending });
    expect(late?.overdue).toBe(true);
    expect(late?.reason).toMatch(/overdue$/);
    expect(decideAfcFetch({ now: nightOf("2026-10-21"), latestSalaryPayslipPeriod: "2026-09", latestContributionPeriod: "2026-09" })).toBeNull();
    // The contribution never lags the payslips the other way: a ledger ahead of the payslips reads nothing.
    expect(decideAfcFetch({ now: nightOf("2026-10-21"), latestSalaryPayslipPeriod: "2026-08", latestContributionPeriod: "2026-09" })).toBeNull();
  });
  it("reads nothing without a payslip, and crosses the year end", () => {
    expect(decideAfcFetch({ now: nightOf("2026-10-21"), latestSalaryPayslipPeriod: null, latestContributionPeriod: "2026-04" })).toBeNull();
    expect(decideAfcFetch({ now: nightOf("2027-01-13"), latestSalaryPayslipPeriod: "2026-12", latestContributionPeriod: "2026-11" })).toBeNull();
    expect(decideAfcFetch({ now: nightOf("2027-01-14"), latestSalaryPayslipPeriod: "2026-12", latestContributionPeriod: null })?.expected_period).toBe("2026-12");
    expect(decideAfcFetch({ now: nightOf("2027-02-01"), latestSalaryPayslipPeriod: "2026-12", latestContributionPeriod: "2026-11" })?.overdue).toBe(true);
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
