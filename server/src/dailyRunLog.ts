/**
 * Outcome log for the unattended daily bank run (`scraper/daily-run.sh`, LaunchAgent
 * `com.user.nw-tracker-daily`).
 *
 * The run is deliberately fail-soft — one bank being down must not stop the others — which is
 * exactly what makes a silent failure possible: the log file grows, nothing surfaces, and a
 * broken fetch can go unnoticed for weeks while the app looks healthy. So every run records an
 * `app_messages` row: `log` when everything passed, `notification` (unread badge in the app) when
 * any step failed.
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

// The hourly e-mail poll (`scraper/email-run.sh`) records under its OWN titles: the daily
// titles drive `dailyRunAlreadyRanToday` (the 22:00 run's same-day skip) and
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

/**
 * Did a run already happen today (Chile)?
 *
 * The read side of the scheduled run's same-day skip: triggering the sync by hand should make the
 * 22:00 LaunchAgent a no-op, rather than hitting the banks a second time for movements that were
 * already imported hours earlier. Counts failed runs too — a run that failed today was still a
 * real attempt, and the nightly job silently retrying it would hide the failure the alert raised.
 */
export function dailyRunAlreadyRanToday(nowYmd = chileCalendarTodayYmd()): boolean {
  const last = lastDailyRunAt();
  return last != null && chileYmdFromStoredUtc(last) === nowYmd;
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

function formatRunStepLines(steps: readonly DailyRunStep[]): string[] {
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
  body: string;
};

/**
 * Record one run. A failure writes a `notification` so the app shows an unread badge; a clean run
 * writes a `log` alongside the sync/import entries.
 */
export function recordDailyRun(
  steps: readonly DailyRunStep[],
  opts?: { dryRun?: boolean; nowYmd?: string }
): RecordDailyRunResult {
  const ok = steps.every((s) => s.ok);
  const body = formatDailyRunBody(steps, opts?.nowYmd);
  const message_id = insertAppMessage(
    ok ? "log" : "notification",
    ok ? DAILY_RUN_MESSAGE_TITLE : DAILY_RUN_FAILED_TITLE,
    body,
    opts?.dryRun ?? false
  );
  return { ok, message_id, body };
}

export type RecordHourlyEmailRunResult = {
  ok: boolean;
  /** False for a quiet success — nothing fetched, nothing imported, nothing written. */
  recorded: boolean;
  message_id: number | null;
  kind: "log" | "notification" | null;
  body: string;
};

function lastHourlyEmailFailureAt(): string | null {
  const row = db
    .prepare(`SELECT created_at FROM app_messages WHERE title = ? ORDER BY created_at DESC LIMIT 1`)
    .get(HOURLY_EMAIL_RUN_FAILED_TITLE) as { created_at: string } | undefined;
  return row?.created_at ?? null;
}

/**
 * Record one hourly e-mail poll (`scraper/email-run.sh`).
 *
 * Quiet successes are not recorded — 24 no-op rows a day is noise, and the runner's log
 * file keeps the trace. A run with activity records a `log`. Failures always record, but
 * only the FIRST failure of the Chile day is a `notification` (unread badge): a persistent
 * outage badges once per day instead of hourly, and the nightly run — which executes the
 * same e-mail steps — still raises the macOS alert for anything that keeps failing.
 */
export function recordHourlyEmailRun(
  steps: readonly DailyRunStep[],
  opts: { activity: boolean; dryRun?: boolean; nowYmd?: string }
): RecordHourlyEmailRunResult {
  const ok = steps.every((s) => s.ok);
  const body = formatRunStepLines(steps).join("\n");
  if (ok && !opts.activity) {
    return { ok, recorded: false, message_id: null, kind: null, body };
  }
  let kind: "log" | "notification" = "log";
  if (!ok) {
    const lastFailure = lastHourlyEmailFailureAt();
    const nowYmd = opts.nowYmd ?? chileCalendarTodayYmd();
    const alreadyFailedToday = lastFailure != null && chileYmdFromStoredUtc(lastFailure) === nowYmd;
    kind = alreadyFailedToday ? "log" : "notification";
  }
  const message_id = insertAppMessage(
    kind,
    ok ? HOURLY_EMAIL_RUN_MESSAGE_TITLE : HOURLY_EMAIL_RUN_FAILED_TITLE,
    body,
    opts.dryRun ?? false
  );
  return { ok, recorded: true, message_id, kind, body };
}
