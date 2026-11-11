import { describe, expect, it } from "vitest";
import type { SantanderState } from "nw-tracker-contracts";
import {
  decideAfcFetch,
  decideMetlifeRead,
  decidePayslipsRun,
  metlifeQuoteMissing,
  metlifeQuoteSlotAtOrBefore,
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

describe("the mortgage lender's quote slot and read", () => {
  // November 2026 is UTC−3 in Chile: 07:00 Chile on the 11th = 10:00Z.
  const SEVEN_ON_11TH = at("2026-11-11T10:00:00Z");

  it("the quote is missing from 07:00 on the 11th until a quote due next month is stored", () => {
    expect(metlifeQuoteMissing(at("2026-11-11T09:59:00Z"), "2026-11-10")).toBe(false);
    expect(metlifeQuoteMissing(SEVEN_ON_11TH, "2026-11-10")).toBe(true);
    expect(metlifeQuoteMissing(at("2026-11-20T15:00:00Z"), null)).toBe(true);
    expect(metlifeQuoteMissing(at("2026-11-20T15:00:00Z"), "2026-12-10")).toBe(false);
    expect(metlifeQuoteMissing(at("2026-11-05T15:00:00Z"), "2026-11-10")).toBe(false);
    // December's cycle is due in January of the next year.
    expect(metlifeQuoteMissing(at("2026-12-11T12:00:00Z"), "2026-12-10")).toBe(true);
    expect(metlifeQuoteMissing(at("2026-12-11T12:00:00Z"), "2027-01-11")).toBe(false);
  });

  it("the extra slot is 07:00 on the 11th only, once due, and only while the quote is missing", () => {
    expect(metlifeQuoteSlotAtOrBefore(at("2026-11-11T09:30:00Z"), null)).toBeNull();
    expect(metlifeQuoteSlotAtOrBefore(at("2026-11-11T10:00:30Z"), null)).toEqual(SEVEN_ON_11TH);
    expect(metlifeQuoteSlotAtOrBefore(at("2026-11-11T10:00:30Z"), "2026-12-10")).toBeNull();
    expect(metlifeQuoteSlotAtOrBefore(at("2026-11-12T10:00:30Z"), null)).toBeNull();
  });

  it("decideIngestRun queues an hourly for the 07:00 slot, then the :30 grid takes over", () => {
    const base = {
      lastNightlySlot: at("2026-11-11T01:00:00Z"),
      lastDailyRunAt: at("2026-11-11T01:20:00Z"),
      lastHourlySlot: at("2026-11-11T09:30:00Z"),
    };
    const now = at("2026-11-11T10:00:30Z");
    expect(decideIngestRun({ ...base, now, extraHourlySlot: metlifeQuoteSlotAtOrBefore(now, null) })).toMatchObject({
      action: "request",
      kind: "hourly",
      slot: SEVEN_ON_11TH,
    });
    // Answered: nothing until 07:30.
    expect(decideIngestRun({ ...base, now, lastHourlySlot: SEVEN_ON_11TH, extraHourlySlot: SEVEN_ON_11TH })).toEqual({ action: "idle" });
    const later = at("2026-11-11T10:31:00Z");
    expect(decideIngestRun({ ...base, now: later, lastHourlySlot: SEVEN_ON_11TH, extraHourlySlot: SEVEN_ON_11TH })).toMatchObject({
      action: "request",
      slot: at("2026-11-11T10:30:00Z"),
    });
  });

  const read = (over: Partial<Parameters<typeof decideMetlifeRead>[0]>) =>
    decideMetlifeRead({
      now: at("2026-11-11T10:00:30Z"),
      hasLoan: true,
      latestQuoteDueOn: "2026-11-10",
      ledgerLastDueMonth: "2026-11",
      receipts: [],
      lastReadRequestedAt: null,
      ...over,
    });

  it("reads for the quote while it is missing, never within an hour of the last read, never without a loan", () => {
    expect(read({})).toMatchObject({ mode: "quote" });
    expect(read({ latestQuoteDueOn: "2026-12-10" })).toBeNull();
    expect(read({ lastReadRequestedAt: at("2026-11-11T09:30:00Z") })).toBeNull();
    expect(read({ lastReadRequestedAt: at("2026-11-11T08:59:00Z") })).toMatchObject({ mode: "quote" });
    expect(read({ hasLoan: false })).toBeNull();
  });

  it("reads the posted cuota while a recent receipt names a cuota the ledger lacks, any day", () => {
    const now = at("2026-11-25T15:00:00Z");
    const receipt = { due_on: "2026-12-10", paid_on: "2026-11-24" };
    expect(read({ now, latestQuoteDueOn: "2026-12-10", receipts: [receipt] })).toMatchObject({ mode: "posted" });
    // The ledger has it: nothing.
    expect(read({ now, latestQuoteDueOn: "2026-12-10", ledgerLastDueMonth: "2026-12", receipts: [receipt] })).toBeNull();
    // An old receipt no longer asks.
    expect(read({ now: at("2026-12-09T15:00:00Z"), latestQuoteDueOn: "2026-12-10", receipts: [receipt] })).toBeNull();
  });
});
