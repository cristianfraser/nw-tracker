import { SANTANDER_MIN_GAP_AFTER_ATTEMPT_MINUTES, type IngestRunKind, type SantanderFetchMode, type SantanderState } from "nw-tracker-contracts";
import { chileCalendarAddDays, chileWallClockAt, dateAtTimeZoneWallClock } from "./chileDate.js";
import { DAILY_RUN_REPEAT_WINDOW_MINUTES } from "./dailyRunLog.js";

/**
 * When the ingest service runs (docs/ingest-split-plan.md, Phase 2) — one pure decision:
 *
 * - The nightly run answers the 22:00 Chile slot. A slot the machine slept through runs on wake
 *   (the latest slot only — three nights asleep is one catch-up run, not three). A slot is
 *   already answered when a run requested for it exists or any daily run was recorded after it
 *   (a manual run, or a LaunchAgent run before this scheduler took over), and is skipped when a
 *   run finished less than an hour ago (a manual run just before 22:00).
 * - The hourly e-mail poll answers the :30 slot of every hour.
 * - A slot answered here is queued (docs/job-queue-plan.md): a run in flight makes it wait in the
 *   queue, never skipped — an hourly that waits past the next slot is absorbed by it.
 */

export const NIGHTLY_SLOT_HOUR_CHILE = 22;
const HOUR_MS = 3_600_000;
const HALF_HOUR_MS = 1_800_000;

/** The latest 22:00 Chile at or before `now`. */
export function nightlySlotAtOrBefore(now: Date): Date {
  const wall = chileWallClockAt(now);
  const today = dateAtTimeZoneWallClock(wall.ymd, NIGHTLY_SLOT_HOUR_CHILE, 0, "America/Santiago");
  if (today.getTime() <= now.getTime()) return today;
  return dateAtTimeZoneWallClock(chileCalendarAddDays(wall.ymd, -1), NIGHTLY_SLOT_HOUR_CHILE, 0, "America/Santiago");
}

/** The latest :30 at or before `now` (Chile's UTC offset is whole hours, so :30 local is :30 UTC). */
export function hourlySlotAtOrBefore(now: Date): Date {
  return new Date(Math.floor((now.getTime() - HALF_HOUR_MS) / HOUR_MS) * HOUR_MS + HALF_HOUR_MS);
}

/** The next slot of each kind strictly after `now` (the nightly ±1 h across a DST change is fine for display). */
export function nextIngestSlotsAfter(now: Date): Record<IngestRunKind, Date> {
  return {
    hourly: new Date(hourlySlotAtOrBefore(now).getTime() + HOUR_MS),
    nightly: nightlySlotAtOrBefore(new Date(now.getTime() + 24 * HOUR_MS)),
  };
}

export type IngestSchedulerInputs = {
  now: Date;
  /** Latest nightly slot a row answers (requested, finished or skipped — not one that never started) or a queue job was enqueued for. */
  lastNightlySlot: Date | null;
  /** Latest hourly slot a row answers or a queue job was enqueued for, whatever became of it. */
  lastHourlySlot: Date | null;
  /** The most recent daily run recorded in app messages (any outcome, any trigger). */
  lastDailyRunAt: Date | null;
};

export type IngestSchedulerDecision =
  | { action: "request"; kind: IngestRunKind; slot: Date; reason: string }
  | { action: "skip"; kind: IngestRunKind; slot: Date; reason: string }
  | { action: "idle" };

function minutes(ms: number): number {
  return Math.round(ms / 60_000);
}

function slotLabel(slot: Date, now: Date): string {
  const late = now.getTime() - slot.getTime();
  return late < 10 * 60_000 ? "on time" : `${minutes(late)} min late (the machine was likely asleep)`;
}

export function decideIngestRun(inputs: IngestSchedulerInputs): IngestSchedulerDecision {
  const { now } = inputs;

  const nightly = nightlySlotAtOrBefore(now);
  const nightlyAnswered =
    (inputs.lastNightlySlot != null && inputs.lastNightlySlot.getTime() >= nightly.getTime()) ||
    (inputs.lastDailyRunAt != null && inputs.lastDailyRunAt.getTime() >= nightly.getTime());
  if (!nightlyAnswered) {
    const sinceLast = inputs.lastDailyRunAt ? now.getTime() - inputs.lastDailyRunAt.getTime() : null;
    if (sinceLast != null && sinceLast >= 0 && sinceLast < DAILY_RUN_REPEAT_WINDOW_MINUTES * 60_000) {
      return {
        action: "skip",
        kind: "nightly",
        slot: nightly,
        reason: `a daily run finished ${minutes(sinceLast)} min ago`,
      };
    }
    return { action: "request", kind: "nightly", slot: nightly, reason: `22:00 slot, ${slotLabel(nightly, now)}` };
  }

  const hourly = hourlySlotAtOrBefore(now);
  if (inputs.lastHourlySlot == null || inputs.lastHourlySlot.getTime() < hourly.getTime()) {
    return { action: "request", kind: "hourly", slot: hourly, reason: `:30 slot, ${slotLabel(hourly, now)}` };
  }
  return { action: "idle" };
}

/**
 * No balance poll this close to the 22:00 slot: the nightly logs in anyway, and a poll at :30 would
 * leave the nightly's own fetch inside the scraper's 30-minute run guard.
 */
export const BALANCE_POLL_NIGHTLY_CLEARANCE_MINUTES = 45;

export type SantanderBalancePollInputs = {
  now: Date;
  /** The feeder's bank facts from its latest report; null before the first report. */
  state: SantanderState | null;
};

/**
 * Whether an hourly poll opens the bank for a balance poll: every hour, except when the login is
 * latched off after a credentials rejection, when the bank was tried moments ago (the nightly's
 * own fetch, a manual run) or when the 22:00 slot is near. The poll compares every product's
 * stated balance with the app and reads only the movements of the ones that disagree — a movement
 * made anywhere (by the user or not) shows within the hour.
 */
export function decideSantanderBalancePoll(i: SantanderBalancePollInputs): { mode: SantanderFetchMode; reason: string } | null {
  if (i.state?.login_latched) return null;
  const lastAttempt = i.state?.last_attempt_at ? new Date(i.state.last_attempt_at) : null;
  if (lastAttempt && i.now.getTime() - lastAttempt.getTime() < SANTANDER_MIN_GAP_AFTER_ATTEMPT_MINUTES * 60_000) return null;
  const nextNightly = nightlySlotAtOrBefore(new Date(i.now.getTime() + 24 * HOUR_MS));
  if (nextNightly.getTime() - i.now.getTime() < BALANCE_POLL_NIGHTLY_CLEARANCE_MINUTES * 60_000) return null;
  return { mode: "balance-poll", reason: "hourly: the bank's balances against the app" };
}

/**
 * Tonight's AFP UNO read: every nightly. The read sends the website's balance; its cuotas against
 * the ledger's decide whether the certificates are read (`applyPensionAccountBalance`), so no
 * calendar rule is needed here.
 */
export function decideAfpUnoFetch(): { reason: string } {
  return { reason: "nightly: the website's balance against the ledger" };
}

/** Tonight's AFC read: every nightly — the stated balance, and the certificate of paid contributions. */
/**
 * Day of the month from which the previous payroll month's AFC contribution is looked for:
 * Previred's electronic deadline is the 13th, and the fund credits a few days later (the
 * September 2026 contribution, paid on the 9th, showed on the 21st).
 */
export const AFC_CONTRIBUTION_WINDOW_DAY = 14;

/**
 * Whether tonight's nightly reads the AFC's sucursal virtual. A payslip for month M says an AFC
 * contribution for M is coming (the employer pays it through Previred during M+1), so from the
 * 14th of M+1 the read runs every night until M's contribution is in the ledger, then nothing
 * until the next payslip's month; a month with no payslip costs no read. `overdue` once M+1 has
 * ended without it — the fetcher then fails its step, so an employer that stopped paying is
 * noticed. The mailed cartolas do not go through this rule: the runner reads the AFC the night
 * a cartola is staged, whatever the server said.
 */
export function decideAfcFetch(i: {
  now: Date;
  /** Newest salary payslip's period (YYYY-MM), or null. */
  latestSalaryPayslipPeriod: string | null;
  /** Newest AFC contribution period in the ledger (YYYY-MM), or null. */
  latestContributionPeriod: string | null;
}): { reason: string; expected_period: string; overdue: boolean } | null {
  const expected = i.latestSalaryPayslipPeriod;
  if (expected == null) return null;
  if (i.latestContributionPeriod != null && i.latestContributionPeriod >= expected) return null;
  const today = chileWallClockAt(i.now).ymd;
  const [y, m] = [Number(expected.slice(0, 4)), Number(expected.slice(5, 7))];
  const ym = (year: number, month: number) => `${year + Math.floor((month - 1) / 12)}-${String(((month - 1) % 12) + 1).padStart(2, "0")}`;
  const windowStart = `${ym(y, m + 1)}-${String(AFC_CONTRIBUTION_WINDOW_DAY).padStart(2, "0")}`;
  if (today < windowStart) return null;
  const overdue = today >= `${ym(y, m + 2)}-01`;
  return {
    reason: `no AFC contribution for ${expected} in the ledger yet (payslip on file, window from ${windowStart})${overdue ? " — overdue" : ""}`,
    expected_period: expected,
    overdue,
  };
}

/** The last day of a month on which the nightly still looks for the previous month's payslip. */
export const PAYSLIP_FETCH_LAST_DAY_OF_MONTH = 15;

/**
 * Whether tonight's nightly reads the employer's payroll portal, imports the payslips, or both.
 * The liquidación of month M is published around its last business day (payday), so from the 1st
 * of M+1 through the 15th the portal is read every night until M's payslip is stored — a month
 * whose payslip never appears (no job) costs fifteen reads, then the nightly stops asking. The
 * import alone runs while the newest payslip has no deposit paired: pairing reads the monthly
 * cartola, which lands days after the payslip, so the import pairs it the night the cartola does.
 */
/**
 * Day of the month the mortgage cuota becomes payable (the same window `mortgageUfReminder.ts`
 * evaluates: the 11th of the cycle month through the 10th of the next).
 */
export const MORTGAGE_CUOTA_DAY = 11;

/**
 * Whether this run (hourly or nightly) reads the user's mortgage sheet: from the 11th of a month
 * the cycle's cuota is payable and the sheet is STALE until a regular cuota dated on or after
 * that 11th is in the ledger — every run reads the sheet (a Numbers file, ~15 s) until the user
 * posts the paid row; once it is in, nothing is read until the next 11th. A cuota paid late
 * (after the 10th of the next month) keeps the sheet stale, which is also the overdue signal.
 */
export function decideMortgageSheetRun(i: {
  now: Date;
  /** Newest regular (numbered) cuota's payment day in the ledger, or null. */
  latestCuotaPaidOn: string | null;
}): { reason: string } | null {
  const today = chileWallClockAt(i.now).ymd;
  const day = Number(today.slice(8, 10));
  const [y, m] = [Number(today.slice(0, 4)), Number(today.slice(5, 7))];
  // The cycle whose payable window has opened: this month's 11th, or last month's before the 11th.
  const cycleMonth = day >= MORTGAGE_CUOTA_DAY ? `${y}-${String(m).padStart(2, "0")}` : m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, "0")}`;
  const windowStart = `${cycleMonth}-${String(MORTGAGE_CUOTA_DAY).padStart(2, "0")}`;
  if (i.latestCuotaPaidOn != null && i.latestCuotaPaidOn >= windowStart) return null;
  return { reason: `no mortgage cuota in the ledger since ${windowStart}` };
}

export function decidePayslipsRun(i: {
  now: Date;
  /** Newest stored payslip: its period (YYYY-MM) and whether a deposit is paired with it. */
  latest: { period: string; paired: boolean } | null;
}): { fetch: boolean; reason: string } | null {
  const today = chileWallClockAt(i.now).ymd;
  const day = Number(today.slice(8, 10));
  const [y, m] = [Number(today.slice(0, 4)), Number(today.slice(5, 7))];
  const previous = m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, "0")}`;
  if (day <= PAYSLIP_FETCH_LAST_DAY_OF_MONTH && (i.latest == null || i.latest.period < previous)) {
    return { fetch: true, reason: `no payslip for ${previous} yet` };
  }
  if (i.latest && !i.latest.paired && i.latest.period >= previous) {
    return { fetch: false, reason: `payslip ${i.latest.period} has no deposit paired yet` };
  }
  return null;
}
