import type { IngestRunKind } from "nw-tracker-contracts";
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
