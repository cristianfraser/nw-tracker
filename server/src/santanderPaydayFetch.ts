import { chileWallClockAt } from "./chileDate.js";
import { isChileBusinessDay, nextChileBusinessDayYmd } from "./marketHolidays.js";

/**
 * Should the hourly e-mail poll fetch Santander on payday morning?
 *
 * The salary lands in checking on the month's last Chile business day, in the morning (2026-09-30:
 * between 07:45 and 08:45), but checking movements only arrive with the 22:00 bank run, so the
 * deposit stayed out of the app all day. On that day the first poll from
 * {@link PAYDAY_FETCH_FROM_HOUR}:00 Chile runs the Santander fetch once. Due when all of these hold —
 *  - today (Chile) is the last Chile business day of its month,
 *  - it is {@link PAYDAY_FETCH_FROM_HOUR}:00 or later,
 *  - no payday fetch was tried today (one bank login, never hourly retries),
 *  - no Santander fetch has succeeded today from that hour on (the nightly catch-up may already
 *    have fetched this poll or an earlier one),
 *  - the login is not latched off after a credentials rejection,
 *  - the last attempt against the bank is at least {@link PAYDAY_MIN_GAP_AFTER_ATTEMPT_MINUTES}
 *    old, so the scraper's own 30-minute run guard never refuses it.
 */
export const PAYDAY_FETCH_FROM_HOUR = 9;
export const PAYDAY_MIN_GAP_AFTER_ATTEMPT_MINUTES = 35;

export function isLastChileBusinessDayOfMonth(ymd: string): boolean {
  if (!isChileBusinessDay(ymd)) return false;
  const next = nextChileBusinessDayYmd(ymd);
  if (!next) throw new Error(`no Chile business day within two weeks after ${ymd}`);
  return next.slice(0, 7) !== ymd.slice(0, 7);
}

export type PaydayFetchInputs = {
  now: Date;
  /** Chile day of the last payday fetch attempt. */
  lastPaydayAttemptYmd: string | null;
  /** Newest successful Santander web fetch (the newest `card-movements-*.json`). */
  lastSuccessfulFetchAt: Date | null;
  /** Newest attempt against the bank (`.scraper-run-state.json`). */
  lastBankAttemptAt: Date | null;
  loginLatched: boolean;
};

export type PaydayFetchDecision = { due: boolean; reason: string };

export function santanderPaydayFetchDecision(inputs: PaydayFetchInputs): PaydayFetchDecision {
  const wall = chileWallClockAt(inputs.now);
  if (!isLastChileBusinessDayOfMonth(wall.ymd)) {
    return { due: false, reason: `${wall.ymd} is not the last business day of the month` };
  }
  if (wall.hour < PAYDAY_FETCH_FROM_HOUR) {
    return { due: false, reason: `payday — waiting for ${PAYDAY_FETCH_FROM_HOUR}:00` };
  }
  if (inputs.lastPaydayAttemptYmd === wall.ymd) {
    return { due: false, reason: "payday fetch already tried today" };
  }
  if (inputs.lastSuccessfulFetchAt) {
    const fetched = chileWallClockAt(inputs.lastSuccessfulFetchAt);
    if (fetched.ymd === wall.ymd && fetched.hour >= PAYDAY_FETCH_FROM_HOUR) {
      return { due: false, reason: `already fetched this payday morning (${fetched.hour}:${String(fetched.minute).padStart(2, "0")})` };
    }
  }
  if (inputs.loginLatched) {
    return { due: false, reason: "login latched off after a credentials rejection" };
  }
  if (inputs.lastBankAttemptAt) {
    const ageMinutes = (inputs.now.getTime() - inputs.lastBankAttemptAt.getTime()) / 60_000;
    if (ageMinutes < PAYDAY_MIN_GAP_AFTER_ATTEMPT_MINUTES) {
      return {
        due: false,
        reason: `last bank attempt ${Math.floor(ageMinutes)} min ago — waiting ${PAYDAY_MIN_GAP_AFTER_ATTEMPT_MINUTES} min`,
      };
    }
  }
  return { due: true, reason: `payday (${wall.ymd}) — fetching the salary deposit` };
}
