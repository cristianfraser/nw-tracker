import { chileCalendarAddDays, type ChileWallClock } from "./chileDate.js";
import { isChileBusinessDay } from "./marketHolidays.js";

/**
 * The Risky Norris composition sync's daily slots (Chile wall time). Several a day, on purpose:
 * each run logs the positions date Fintual states and the anchor day it found («as of …,
 * anchored …»), so the run log shows when Fintual publishes yesterday's positions and its
 * official cuota (the public serie prints day D on D+1). A run that finds nothing new
 * re-anchors on the same day, which changes nothing. Measuring since 2026-11-19; once the
 * publish time is known, keep the slots that find something new. 18:30 stays as the backstop:
 * the evening run was the only one before, and in 2026-09 a 10:00 run found nothing newer
 * than D−2.
 */
export const FINTUAL_RN_COMPOSITION_SLOTS_CHILE: readonly { hour: number; minute: number }[] = [
  { hour: 10, minute: 0 },
  { hour: 12, minute: 0 },
  { hour: 15, minute: 0 },
  { hour: 18, minute: 30 },
];

/**
 * A day with something new to anchor on: a Chile business day (the composition may have moved and
 * the previous business day's cuota is published), or the day after one (a Friday's cuota
 * publishes on Saturday). A Sunday, or a holiday following a weekend, brings nothing.
 */
export function isFintualRnCompositionDueDay(ymd: string): boolean {
  return isChileBusinessDay(ymd) || isChileBusinessDay(chileCalendarAddDays(ymd, -1));
}

function slotKey(ymd: string, slot: { hour: number; minute: number }): string {
  return `${ymd} ${String(slot.hour).padStart(2, "0")}:${String(slot.minute).padStart(2, "0")}`;
}

/**
 * The slot in force at `cl` — the latest slot of a due day at or before the wall time — as
 * `YYYY-MM-DD HH:MM`, or null before the first slot or on a day that is not due.
 */
export function rnCompositionCurrentSlotKey(cl: ChileWallClock): string | null {
  if (!isFintualRnCompositionDueDay(cl.ymd)) return null;
  const nowMins = cl.hour * 60 + cl.minute;
  let found: string | null = null;
  for (const slot of FINTUAL_RN_COMPOSITION_SLOTS_CHILE) {
    if (slot.hour * 60 + slot.minute <= nowMins) found = slotKey(cl.ymd, slot);
  }
  return found;
}

/** The first slot strictly after `cl` on its own day, if that day is due. */
export function rnCompositionLaterSlotToday(cl: ChileWallClock): { hour: number; minute: number } | null {
  if (!isFintualRnCompositionDueDay(cl.ymd)) return null;
  const nowMins = cl.hour * 60 + cl.minute;
  return FINTUAL_RN_COMPOSITION_SLOTS_CHILE.find((s) => s.hour * 60 + s.minute > nowMins) ?? null;
}
