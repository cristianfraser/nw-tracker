import type { IngestRunKind, SantanderFetchMode, SantanderState } from "nw-tracker-contracts";
import { santanderPaydayFetchDecision } from "./santanderPaydayFetch.js";
import { chileCalendarAddDays, chileWallClockAt, dateAtTimeZoneWallClock } from "./chileDate.js";
import { DAILY_RUN_REPEAT_WINDOW_MINUTES } from "./dailyRunLog.js";

/**
 * When the ingest service runs (docs/ingest-split-plan.md, Phase 2) — the rules the two timed
 * LaunchAgents and `daily-run.sh --scheduled` used to hold, as one pure decision:
 *
 * - The nightly run answers the 22:00 Chile slot. A slot the machine slept through runs on wake
 *   (the latest slot only — three nights asleep is one catch-up run, not three). A slot is
 *   already answered when a run requested for it exists or any daily run was recorded after it
 *   (a manual run, or a LaunchAgent run before this scheduler took over), and is skipped when a
 *   run finished less than an hour ago (a manual run just before 22:00).
 * - The hourly e-mail poll answers the :30 slot of every hour; while another run is in flight it
 *   skips that hour, as the shell poll skipped behind the nightly.
 * - The nightly waits for a run in flight instead of skipping.
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

export type IngestSchedulerInputs = {
  now: Date;
  /** Latest nightly slot a row answers (requested, finished or skipped — not one that never started). */
  lastNightlySlot: Date | null;
  /** Latest hourly slot a row answers, whatever became of it. */
  lastHourlySlot: Date | null;
  /** The most recent daily run recorded in app messages (any outcome, any trigger). */
  lastDailyRunAt: Date | null;
  /** A run this scheduler requested that has not reported back. */
  inFlight: { kind: IngestRunKind } | null;
};

export type IngestSchedulerDecision =
  | { action: "request"; kind: IngestRunKind; slot: Date; reason: string }
  | { action: "skip"; kind: IngestRunKind; slot: Date; reason: string }
  | { action: "wait"; kind: IngestRunKind; slot: Date; reason: string }
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
    if (inputs.inFlight) {
      return { action: "wait", kind: "nightly", slot: nightly, reason: `a ${inputs.inFlight.kind} run is in flight` };
    }
    return { action: "request", kind: "nightly", slot: nightly, reason: `22:00 slot, ${slotLabel(nightly, now)}` };
  }

  const hourly = hourlySlotAtOrBefore(now);
  if (inputs.lastHourlySlot == null || inputs.lastHourlySlot.getTime() < hourly.getTime()) {
    if (inputs.inFlight) {
      return { action: "skip", kind: "hourly", slot: hourly, reason: `a ${inputs.inFlight.kind} run is in flight` };
    }
    return { action: "request", kind: "hourly", slot: hourly, reason: `:30 slot, ${slotLabel(hourly, now)}` };
  }
  return { action: "idle" };
}

/** A catch-up slot counts as passed 30 minutes after 22:00, once the nightly has had its chance. */
const CATCH_UP_GRACE_MS = 30 * 60_000;
export const SANTANDER_MIN_GAP_AFTER_ATTEMPT_MINUTES = 35;

export type SantanderFetchInputs = {
  now: Date;
  /** The feeder's bank facts from its latest report; null before the first report. */
  state: SantanderState | null;
  /** When the latest catch-up this scheduler asked for was attempted (not declined); the feeder's
   * own marker in `state` counts too. */
  lastCatchUpAttemptAt: Date | null;
  /** Chile day of the latest payday fetch attempted. */
  lastPaydayAttemptYmd: string | null;
};

/**
 * The bank fetch an hourly poll should make, if any — the rules `email-run.sh` asked
 * `check:santander-catchup` and `check:santander-payday-fetch` for, now decided here from the
 * feeder's reported facts and this scheduler's own history. Catch-up first: it retries a nightly
 * fetch that failed or never ran, once per 22:00 slot — the nightly fetch is the only reader of
 * the card's unbilled movements, and a day it misses across a facturación close is lost until
 * the statement. Otherwise the payday morning fetch (`santanderPaydayFetch.ts`).
 */
export function decideSantanderFetch(i: SantanderFetchInputs): { mode: SantanderFetchMode; reason: string } | null {
  if (!i.state) return null;
  // An attempt counts whoever made it: this scheduler, or the shell runners before the switch.
  const markerCatchUp = i.state.last_catch_up_attempt_at ? new Date(i.state.last_catch_up_attempt_at) : null;
  const lastCatchUp =
    markerCatchUp && (!i.lastCatchUpAttemptAt || markerCatchUp > i.lastCatchUpAttemptAt) ? markerCatchUp : i.lastCatchUpAttemptAt;
  const markerPayday = i.state.last_payday_attempt_ymd;
  const lastPayday =
    markerPayday && (!i.lastPaydayAttemptYmd || markerPayday > i.lastPaydayAttemptYmd) ? markerPayday : i.lastPaydayAttemptYmd;
  const lastAttempt = i.state.last_attempt_at ? new Date(i.state.last_attempt_at) : null;
  const lastSuccess = i.state.last_success_at ? new Date(i.state.last_success_at) : null;
  const slot = nightlySlotAtOrBefore(new Date(i.now.getTime() - CATCH_UP_GRACE_MS));
  const recentAttempt =
    lastAttempt != null && i.now.getTime() - lastAttempt.getTime() < SANTANDER_MIN_GAP_AFTER_ATTEMPT_MINUTES * 60_000;
  const catchUpDue =
    !(lastSuccess && lastSuccess.getTime() >= slot.getTime()) &&
    !(lastCatchUp && lastCatchUp.getTime() >= slot.getTime()) &&
    !i.state.login_latched &&
    !recentAttempt;
  if (catchUpDue) {
    const since = lastSuccess ? ` (last: ${lastSuccess.toISOString()})` : "";
    return { mode: "catch-up", reason: `no Santander fetch has succeeded since the ${slot.toISOString()} slot${since}` };
  }
  const payday = santanderPaydayFetchDecision({
    now: i.now,
    lastPaydayAttemptYmd: lastPayday,
    lastSuccessfulFetchAt: lastSuccess,
    lastBankAttemptAt: lastAttempt,
    loginLatched: i.state.login_latched,
  });
  return payday.due ? { mode: "payday", reason: payday.reason } : null;
}

/** The day of the month from which the pension certificates are read nightly. */
export const AFP_UNO_FIRST_DAY_OF_MONTH = 10;

/**
 * Whether tonight's nightly reads AFP UNO's certificates. Contributions land around the 10th
 * (fecha caja 06–12 in 2025–26) and the unemployment insurance's a week later, so from the 10th
 * the account is read every night until a read imports new rows with nothing pending or to fix;
 * then not again until the next 10th. A month with nothing new is read through its last day.
 */
export function decideAfpUnoFetch(i: { now: Date; lastCleanImportAt: Date | null }): { reason: string } | null {
  const today = chileWallClockAt(i.now).ymd;
  const day = Number(today.slice(8, 10));
  if (day < AFP_UNO_FIRST_DAY_OF_MONTH) return null;
  const fromYmd = `${today.slice(0, 8)}${String(AFP_UNO_FIRST_DAY_OF_MONTH).padStart(2, "0")}`;
  if (i.lastCleanImportAt && chileWallClockAt(i.lastCleanImportAt).ymd >= fromYmd) return null;
  return { reason: `no clean import since ${fromYmd}` };
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
