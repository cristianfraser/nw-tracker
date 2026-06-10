import { chileCalendarAddDays, type ChileWallClock } from "./chileDate.js";
import type { GlobalSyncStateFile } from "./globalSyncState.js";
import { isChileBusinessDay, isChileHoliday } from "./marketHolidays.js";

/** Last calendar day of a consecutive Chile holiday run (Fintual may still publish that day). */
export function isLastDayOfChileHolidayStreak(ymd: string): boolean {
  if (!isChileHoliday(ymd)) return false;
  const next = chileCalendarAddDays(ymd, 1);
  return !isChileHoliday(next);
}

/**
 * Last calendar day before Chile business resumes (weekend, holiday, or mixed blocks).
 * Fintual evening poll / stale applies here at 18:00 — not on earlier non-business days in the block.
 */
export function isLastDayOfChileNonBusinessBlock(ymd: string): boolean {
  if (isChileBusinessDay(ymd)) return false;
  return isChileBusinessDay(chileCalendarAddDays(ymd, 1));
}

/**
 * Days when Fintual may publish a new fund cuota: Chile business days, plus the last day of each
 * non-business block (e.g. Sunday after a weekend; Monday after Sat–Sun–Mon holidays).
 */
export function isFintualFundPublishDay(ymd: string): boolean {
  if (isChileBusinessDay(ymd)) return true;
  return isLastDayOfChileNonBusinessBlock(ymd);
}

/** Evening poll days when a new fund cuota may be expected (business day or end of a non-business block). */
export function fintualExpectsCuotaOnPollDay(ymd: string): boolean {
  return isFintualFundPublishDay(ymd);
}

/**
 * After 18:00 Chile, API fund publish date is still before the poll calendar day — today's cuota is not out yet.
 * A no-change poll must not clear stale or evening-settled in this case.
 */
export function fintualPublishLagsPollCalendarDay(cl: ChileWallClock, publishYmd: string): boolean {
  if (cl.hour < 18) return false;
  if (!fintualExpectsCuotaOnPollDay(cl.ymd)) return false;
  return publishYmd < cl.ymd;
}

export function fintualEveningPollClock(cl: ChileWallClock, pollYmd?: string): ChileWallClock {
  return pollEveningClock(cl, pollYmd ?? cl.ymd);
}

function pollEveningClock(cl: ChileWallClock, pollYmd: string): ChileWallClock {
  return {
    ...cl,
    ymd: pollYmd,
    hour: 19,
    minute: 0,
    day: Number(pollYmd.slice(8, 10)),
    monthKey: pollYmd.slice(0, 7),
  };
}

function pollEveningClockForYmd(pollYmd: string): ChileWallClock {
  return pollEveningClock(
    {
      ymd: pollYmd,
      year: Number(pollYmd.slice(0, 4)),
      month: Number(pollYmd.slice(5, 7)),
      day: Number(pollYmd.slice(8, 10)),
      hour: 0,
      minute: 0,
      monthKey: pollYmd.slice(0, 7),
    },
    pollYmd
  );
}

/**
 * `pollYmd` evening expectations are met: API publish is current for that poll day and DB
 * matches the polled NAV signature (does not rely on `fintualEveningSettledYmd`, which can lag).
 */
export function fintualPollDayCaughtUp(
  pollYmd: string,
  publishYmd: string | null | undefined,
  state: GlobalSyncStateFile,
  checkSig: string | null | undefined
): boolean {
  if (!publishYmd || !checkSig || !state.fintualLastAppliedSig) return false;
  if (checkSig !== state.fintualLastAppliedSig) return false;
  if (
    state.fintualLastAppliedPublishYmd != null &&
    publishYmd !== state.fintualLastAppliedPublishYmd
  ) {
    return false;
  }
  if (fintualPublishLagsPollCalendarDay(pollEveningClockForYmd(pollYmd), publishYmd)) {
    return false;
  }
  return true;
}

/**
 * Before 18:00 Chile, carry forward stale from the last post-18:00 poll on a prior publish day
 * when that evening never settled (publish lag, sig mismatch, etc.).
 */
export function fintualPriorEveningUnresolved(
  cl: ChileWallClock,
  state: GlobalSyncStateFile
): boolean {
  if (cl.hour >= 18) return false;
  const pollYmd = state.fintualLastCheckYmd;
  if (!pollYmd || pollYmd >= cl.ymd) return false;
  if (!fintualExpectsCuotaOnPollDay(pollYmd)) return false;
  return !fintualPollDayCaughtUp(
    pollYmd,
    state.fintualLastPublishYmd,
    state,
    state.fintualLastCheckSig
  );
}

/** True when `pollYmd` evening poll is still unresolved for `publishYmd` / signatures. */
export function fintualPollDayStillUnresolved(
  pollYmd: string,
  publishYmd: string,
  state: GlobalSyncStateFile,
  checkSig: string
): boolean {
  return !fintualPollDayCaughtUp(pollYmd, publishYmd, state, checkSig);
}

/** Latest Fintual publish day strictly before `beforeYmd`. */
export function priorFintualPublishYmd(beforeYmd: string, maxSteps = 14): string | null {
  let cur = chileCalendarAddDays(beforeYmd, -1);
  for (let i = 0; i < maxSteps; i++) {
    if (isFintualFundPublishDay(cur)) return cur;
    cur = chileCalendarAddDays(cur, -1);
  }
  return null;
}

export type FintualPublishDateHints = {
  /** Any mapped `real_assets/.../days` row for Chile today. */
  hasTodayInSeries: boolean;
  /** Max `last_day.date` from mapped real_assets (YYYY-MM-DD). */
  lastDayDate: string | null;
};

/**
 * `as_of_date` for evening Fintual apply: today's publish when the API has today's cuota;
 * otherwise the latest published fund day (e.g. Thursday holiday tweak polled on Friday evening).
 */
export function resolveFintualPublishYmd(
  cl: ChileWallClock,
  hints: FintualPublishDateHints
): string {
  if (cl.hour < 18) return cl.ymd;

  const last = hints.lastDayDate?.trim();
  if (last && /^\d{4}-\d{2}-\d{2}$/.test(last)) {
    // API forward-published (holiday end, often visible on a prior business evening).
    if (last > cl.ymd) return last;
  }

  if (hints.hasTodayInSeries && isFintualFundPublishDay(cl.ymd)) {
    return cl.ymd;
  }

  if (last && /^\d{4}-\d{2}-\d{2}$/.test(last)) {
    if (last < cl.ymd) return last;
    if (last === cl.ymd) return cl.ymd;
  }

  return priorFintualPublishYmd(cl.ymd) ?? last ?? cl.ymd;
}
