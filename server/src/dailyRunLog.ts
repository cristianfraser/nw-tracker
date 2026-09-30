/**
 * Outcome log for the unattended daily bank run (`ingest/daily-run.sh`, LaunchAgent
 * `com.user.nw-tracker-daily`).
 *
 * The run is deliberately fail-soft — one bank being down must not stop the others — which is
 * exactly what makes a silent failure possible: the log file grows, nothing surfaces, and a
 * broken fetch can go unnoticed for weeks while the app looks healthy. So every run records an
 * `app_messages` row: `log` when everything passed, `notification` (unread badge in the app) when
 * any step failed — and ALSO for the first clean run after a failure, so the notifications tab
 * (which lists notifications only) shows the outage resolved instead of leaving the failure on top.
 *
 * It also reports the gap since the last successful run, which catches the failure mode a
 * per-run status cannot: a run that never happened at all (Mac asleep or off at 22:00, agent
 * unloaded). `staleDailyRunDays` is the read side of that for any surface that wants to show it.
 */
import { insertAppMessage } from "./appMessages.js";
import { chileCalendarTodayYmd, chileWallClockAt } from "./chileDate.js";
import { db } from "./db.js";

export const DAILY_RUN_MESSAGE_TITLE = "Daily bank run";
export const DAILY_RUN_FAILED_TITLE = "Daily bank run failed";

// The hourly e-mail poll (`ingest/email-run.sh`) records under its OWN titles: the daily
// titles drive `dailyRunFinishedWithin` (the 22:00 run's repeat skip) and
// `staleDailyRunDays`, so an hourly row under them would silently disable the nightly bank
// run for the day and mask a dead one.
export const HOURLY_EMAIL_RUN_MESSAGE_TITLE = "Hourly e-mail poll";
export const HOURLY_EMAIL_RUN_FAILED_TITLE = "Hourly e-mail poll failed";

export type DailyRunStep = {
  label: string;
  ok: boolean;
  /** Seconds the step took, when the runner measured it. */
  seconds?: number | null;
};

/** Most recent run of either outcome, from the messages the runner writes. */
export function lastDailyRunAt(opts?: { successOnly?: boolean }): string | null {
  const row = db
    .prepare(
      opts?.successOnly
        ? `SELECT created_at FROM app_messages WHERE title = ? ORDER BY created_at DESC LIMIT 1`
        : `SELECT created_at FROM app_messages WHERE title IN (?, ?) ORDER BY created_at DESC LIMIT 1`
    )
    .get(
      ...(opts?.successOnly
        ? [DAILY_RUN_MESSAGE_TITLE]
        : [DAILY_RUN_MESSAGE_TITLE, DAILY_RUN_FAILED_TITLE])
    ) as { created_at: string } | undefined;
  return row?.created_at ?? null;
}

/** How close to the previous run the scheduled run counts as a repeat and skips itself. */
export const DAILY_RUN_REPEAT_WINDOW_MINUTES = 60;

/**
 * Did a run finish less than `windowMinutes` ago?
 *
 * The read side of the scheduled run's repeat skip: a 22:00 LaunchAgent run right behind a manual
 * one (or a second launchd fire after a wake) would only log in to the banks again for the same
 * movements. Anything older is not a repeat — until 2026-09-26 the rule was «any run earlier
 * the same Chile day», which let a 12:55 manual run, or even the 04:21 catch-up run launchd fires
 * when the Mac wakes from a night asleep, cancel that evening's run and leave the afternoon's
 * card movements for the next night (2026-09-25). Counts failed runs too — a failure seconds
 * ago was a real attempt.
 */
export function dailyRunFinishedWithin(
  windowMinutes: number = DAILY_RUN_REPEAT_WINDOW_MINUTES,
  now: Date = new Date()
): boolean {
  const last = lastDailyRunAt();
  if (last == null) return false;
  const finished = new Date(`${String(last).trim().replace(" ", "T")}Z`);
  if (Number.isNaN(finished.getTime())) return false;
  const ageMs = now.getTime() - finished.getTime();
  return ageMs >= 0 && ageMs < windowMinutes * 60_000;
}

/**
 * `app_messages.created_at` is UTC (`DEFAULT (datetime('now'))`), stored without a zone marker.
 *
 * Slicing the first 10 characters and comparing them to a Chile date is wrong for exactly the runs
 * this job makes: 22:00 Chile is 02:00 the NEXT day in UTC, so last night's run looks like it
 * happened today and would make tonight's scheduled run skip itself — silently disabling the
 * nightly job.
 */
function chileYmdFromStoredUtc(stored: string): string {
  const parsed = new Date(`${String(stored).trim().replace(" ", "T")}Z`);
  if (Number.isNaN(parsed.getTime())) return String(stored).slice(0, 10);
  return chileWallClockAt(parsed).ymd;
}

/** `YYYY-MM-DD HH:MM` Chile wall clock of a stored UTC timestamp — for the recovery line. */
function chileStampFromStoredUtc(stored: string): string {
  const parsed = new Date(`${String(stored).trim().replace(" ", "T")}Z`);
  if (Number.isNaN(parsed.getTime())) return String(stored);
  const wc = chileWallClockAt(parsed);
  return `${wc.ymd} ${String(wc.hour).padStart(2, "0")}:${String(wc.minute).padStart(2, "0")}`;
}

/**
 * The most recent run recorded under `titles`, when it was the failed one — null when the last
 * run succeeded or none was ever recorded.
 *
 * A success that follows a failure is the one outcome the notifications tab could not express: a
 * failure badges as a `notification`, a clean run is a plain `log`, and the tab lists notifications
 * only — so a resolved outage read as unresolved forever (2026-09-11: the 22:37 «fetch Santander»
 * failure sat on top while the 22:46 retry that fixed it was a log row nobody sees there). The
 * recovery is therefore recorded as a notification too, under the SAME title as any clean run:
 * the titles drive `lastDailyRunAt`, `dailyRunFinishedWithin` and `staleDailyRunDays`, and the
 * kind is part of none of those reads. Only the first success after a failure qualifies — the
 * next clean run finds a success on top and is a log again.
 */
function lastRunFailureToRecoverFrom(
  titles: readonly string[],
  failedTitle: string
): { created_at: string } | null {
  const row = db
    .prepare(
      `SELECT title, created_at FROM app_messages
       WHERE title IN (${titles.map(() => "?").join(", ")})
       ORDER BY created_at DESC, id DESC LIMIT 1`
    )
    .get(...titles) as { title: string; created_at: string } | undefined;
  return row && row.title === failedTitle ? { created_at: row.created_at } : null;
}

function recoveryLine(failure: { created_at: string }): string {
  return `Recovered: the previous run (${chileStampFromStoredUtc(failure.created_at)}) had failed.`;
}

function daysBetweenYmd(fromYmd: string, toYmd: string): number {
  const a = Date.parse(`${fromYmd}T00:00:00Z`);
  const b = Date.parse(`${toYmd}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return 0;
  return Math.round((b - a) / 86_400_000);
}

/**
 * Whole days since the last SUCCESSFUL run. Null when none was ever recorded (nothing to be
 * stale against yet). A value above 1 means at least one nightly run did not complete.
 */
export function staleDailyRunDays(nowYmd = chileCalendarTodayYmd()): number | null {
  const last = lastDailyRunAt({ successOnly: true });
  if (!last) return null;
  // Convert out of UTC first: the job runs at 22:00 Chile, which is stored as the NEXT UTC day,
  // so comparing the raw timestamp under-reported staleness by one for every real run.
  return daysBetweenYmd(chileYmdFromStoredUtc(last), nowYmd);
}

/**
 * A run that completed no step is a failure, never «0 step(s), all ok»: the runners record from an
 * EXIT trap, and a run killed during its first step (2026-09-08: the scraper's Chrome closed by
 * hand mid-fetch) reaches that trap with an empty list.
 */
export function runStepsSucceeded(steps: readonly DailyRunStep[]): boolean {
  return steps.length > 0 && steps.every((s) => s.ok);
}

function formatRunStepLines(steps: readonly DailyRunStep[]): string[] {
  if (steps.length === 0) {
    return ["No step completed — the run ended before its first step finished (killed or crashed)."];
  }
  const failed = steps.filter((s) => !s.ok);
  const lines: string[] = [];
  lines.push(
    failed.length === 0
      ? `${steps.length} step(s), all ok.`
      : `${failed.length} of ${steps.length} step(s) FAILED: ${failed.map((s) => s.label).join(", ")}.`
  );
  for (const s of steps) {
    const secs = s.seconds != null && Number.isFinite(s.seconds) ? ` (${Math.round(s.seconds)}s)` : "";
    lines.push(`${s.ok ? "ok  " : "FAIL"}  ${s.label}${secs}`);
  }
  return lines;
}

export function formatDailyRunBody(steps: readonly DailyRunStep[], nowYmd?: string): string {
  const lines = formatRunStepLines(steps);
  const stale = staleDailyRunDays(nowYmd);
  if (stale == null) {
    lines.push("");
    lines.push("First recorded run.");
  } else if (stale > 1) {
    lines.push("");
    lines.push(`Last successful run was ${stale} day(s) ago — nightly runs were missed.`);
  }
  return lines.join("\n");
}

export type RecordDailyRunResult = {
  ok: boolean;
  message_id: number | null;
  kind: "log" | "notification";
  /** `created_at` of the failed run this clean run recovered from (recorded as a notification). */
  recovered_from: string | null;
  body: string;
};

/**
 * Record one run. A failure writes a `notification` so the app shows an unread badge; a clean run
 * writes a `log` alongside the sync/import entries — except the first clean run after a failure,
 * which is a `notification` under the clean title so the tab shows the failure resolved (see
 * `lastRunFailureToRecoverFrom`).
 */
export function recordDailyRun(
  steps: readonly DailyRunStep[],
  opts?: { dryRun?: boolean; nowYmd?: string }
): RecordDailyRunResult {
  const ok = runStepsSucceeded(steps);
  const recovery = ok
    ? lastRunFailureToRecoverFrom([DAILY_RUN_MESSAGE_TITLE, DAILY_RUN_FAILED_TITLE], DAILY_RUN_FAILED_TITLE)
    : null;
  const stepsBody = formatDailyRunBody(steps, opts?.nowYmd);
  const body = recovery ? `${stepsBody}\n\n${recoveryLine(recovery)}` : stepsBody;
  const kind: "log" | "notification" = ok && !recovery ? "log" : "notification";
  const message_id = insertAppMessage(
    kind,
    ok ? DAILY_RUN_MESSAGE_TITLE : DAILY_RUN_FAILED_TITLE,
    body,
    opts?.dryRun ?? false
  );
  return { ok, message_id, kind, recovered_from: recovery?.created_at ?? null, body };
}

export type RecordHourlyEmailRunResult = {
  ok: boolean;
  /** False for a quiet success — nothing fetched, nothing imported, nothing written. */
  recorded: boolean;
  message_id: number | null;
  kind: "log" | "notification" | null;
  /** `created_at` of the failed poll this clean poll recovered from (recorded as a notification). */
  recovered_from: string | null;
  body: string;
};

function lastHourlyEmailFailureAt(): string | null {
  const row = db
    .prepare(`SELECT created_at FROM app_messages WHERE title = ? ORDER BY created_at DESC LIMIT 1`)
    .get(HOURLY_EMAIL_RUN_FAILED_TITLE) as { created_at: string } | undefined;
  return row?.created_at ?? null;
}

/**
 * Record one hourly e-mail poll (`ingest/email-run.sh`).
 *
 * Quiet successes are not recorded — 24 no-op rows a day is noise, and the runner's log
 * file keeps the trace. A run with activity records a `log`. Failures always record, but
 * only the FIRST failure of the Chile day is a `notification` (unread badge): a persistent
 * outage badges once per day instead of hourly, and the nightly run — which executes the
 * same e-mail steps — still raises the macOS alert for anything that keeps failing.
 *
 * The first success after a failed poll is recorded as a `notification` even when quiet —
 * the recovery has to reach the notifications tab, and a poll with nothing to import is the
 * normal shape of the hour that proves the outage is over (see `lastRunFailureToRecoverFrom`).
 */
export function recordHourlyEmailRun(
  steps: readonly DailyRunStep[],
  opts: { activity: boolean; dryRun?: boolean; nowYmd?: string }
): RecordHourlyEmailRunResult {
  const ok = runStepsSucceeded(steps);
  const recovery = ok
    ? lastRunFailureToRecoverFrom(
        [HOURLY_EMAIL_RUN_MESSAGE_TITLE, HOURLY_EMAIL_RUN_FAILED_TITLE],
        HOURLY_EMAIL_RUN_FAILED_TITLE
      )
    : null;
  const lines = formatRunStepLines(steps);
  if (recovery) lines.push("", recoveryLine(recovery));
  const body = lines.join("\n");
  if (ok && !opts.activity && !recovery) {
    return { ok, recorded: false, message_id: null, kind: null, recovered_from: null, body };
  }
  let kind: "log" | "notification" = "log";
  if (!ok) {
    const lastFailure = lastHourlyEmailFailureAt();
    const nowYmd = opts.nowYmd ?? chileCalendarTodayYmd();
    const alreadyFailedToday = lastFailure != null && chileYmdFromStoredUtc(lastFailure) === nowYmd;
    kind = alreadyFailedToday ? "log" : "notification";
  } else if (recovery) {
    kind = "notification";
  }
  const message_id = insertAppMessage(
    kind,
    ok ? HOURLY_EMAIL_RUN_MESSAGE_TITLE : HOURLY_EMAIL_RUN_FAILED_TITLE,
    body,
    opts.dryRun ?? false
  );
  return { ok, recorded: true, message_id, kind, recovered_from: recovery?.created_at ?? null, body };
}
