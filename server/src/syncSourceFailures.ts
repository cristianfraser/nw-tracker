/**
 * Escalation of a global-sync source that keeps failing (migration 379).
 *
 * A failed step is a line under «Errors:» in that run's `Sync` log row, and a stale source is retried
 * every 15 minutes, so a source broken for days used to leave ~96 log rows a day and no notification.
 * Each source's unbroken run of failed attempts is a row of `sync_source_failure_streaks`: a throwing
 * step creates or extends it, the next successful step deletes it. Only the step's own throw counts
 * (`runSyncStepIfStale`); errors a step pushes while it succeeds (a corrected official bar, a basket
 * self-check) are findings about the data, not a broken source.
 *
 * - Once a streak is older than {@link SYNC_SOURCE_FAILING_NOTIFY_AFTER_MS}, the next failed attempt
 *   raises one `notification`; while it stays broken, one more each
 *   {@link SYNC_SOURCE_FAILING_RENOTIFY_AFTER_MS}.
 * - The success that ends a streak writes «Sync source recovered»: a `notification` when the streak
 *   had been notified (the notifications tab lists notifications only, so a log row would leave the
 *   outage reading as unresolved — the lesson `dailyRunLog.ts` records), else a `log`.
 * - A dry run records nothing; a source the deployment never runs is never attempted and never recorded.
 *
 * Retry cadence is untouched: this module only reads what the steps did.
 */
import { insertAppMessage } from "./appMessages.js";
import { chileWallClockAt } from "./chileDate.js";
import { deploymentProfile } from "./config.js";
import { db } from "./db.js";
import type { GlobalSyncSource } from "./syncSourceIds.js";

/**
 * One threshold for every source. Every global-sync source publishes at most once a day (EOD closes,
 * the SP / Banco Central / Fintual daily values, the monthly series, the CMF filing, the Risky Norris
 * slots) — intraday prices are the live-quotes poll, not this scheduler. 12 h lets a transient
 * outage (Yahoo down for an hour, the network after a wake) recover quietly, and still reports an
 * evening publication that failed all night by the next morning, before the next one is due. A source
 * attempted once a day (the CMF filing) notifies on its second failed day.
 */
export const SYNC_SOURCE_FAILING_NOTIFY_AFTER_MS = 12 * 60 * 60_000;

/**
 * «One more per further day»: 23 h rather than 24 so a source attempted once a day at the same wall
 * time (whose attempts land a few seconds either side of 24 h apart) repeats daily, not every other day.
 */
export const SYNC_SOURCE_FAILING_RENOTIFY_AFTER_MS = 23 * 60 * 60_000;

export const SYNC_SOURCE_FAILING_TITLE_PREFIX = "Sync source failing: ";
export const SYNC_SOURCE_RECOVERED_TITLE_PREFIX = "Sync source recovered: ";

export type SyncSourceOutcome = {
  source: GlobalSyncSource;
  /** The step's label (`SYNC_SOURCES[source].label`), the name the sync log uses. */
  label: string;
  at: Date;
} & ({ ok: true } | { ok: false; message: string });

type StreakRow = {
  source: string;
  failing_since: string;
  last_failure_at: string;
  failures: number;
  last_error: string;
  notified_at: string | null;
};

/** `datetime('now')` format, UTC — what `app_messages.created_at` holds. */
function sqliteUtc(d: Date): string {
  return d.toISOString().slice(0, 19).replace("T", " ");
}

function parseSqliteUtc(s: string): Date {
  const d = new Date(`${s.replace(" ", "T")}Z`);
  if (Number.isNaN(d.getTime())) throw new Error(`sync_source_failure_streaks: unreadable timestamp ${s}`);
  return d;
}

/** `YYYY-MM-DD HH:MM` Chile wall clock of a stored UTC timestamp. */
function chileStamp(stored: string): string {
  const wc = chileWallClockAt(parseSqliteUtc(stored));
  return `${wc.ymd} ${String(wc.hour).padStart(2, "0")}:${String(wc.minute).padStart(2, "0")}`;
}

function hoursText(ms: number): string {
  const h = Math.floor(ms / 3_600_000);
  return h >= 48 ? `${Math.floor(h / 24)} days` : `${h} h`;
}

export function syncSourceFailureStreak(source: GlobalSyncSource): StreakRow | null {
  return (
    (db.prepare(`SELECT * FROM sync_source_failure_streaks WHERE source = ?`).get(source) as StreakRow | undefined) ?? null
  );
}

function recordFailure(o: SyncSourceOutcome & { ok: false }): void {
  const at = sqliteUtc(o.at);
  db.prepare(
    `INSERT INTO sync_source_failure_streaks (source, failing_since, last_failure_at, failures, last_error)
     VALUES (?, ?, ?, 1, ?)
     ON CONFLICT (source) DO UPDATE SET
       last_failure_at = excluded.last_failure_at,
       failures = failures + 1,
       last_error = excluded.last_error`
  ).run(o.source, at, at, o.message);
  const streak = syncSourceFailureStreak(o.source)!;
  const failingForMs = o.at.getTime() - parseSqliteUtc(streak.failing_since).getTime();
  if (failingForMs < SYNC_SOURCE_FAILING_NOTIFY_AFTER_MS) return;
  if (
    streak.notified_at != null &&
    o.at.getTime() - parseSqliteUtc(streak.notified_at).getTime() < SYNC_SOURCE_FAILING_RENOTIFY_AFTER_MS
  ) {
    return;
  }
  insertAppMessage(
    "notification",
    `${SYNC_SOURCE_FAILING_TITLE_PREFIX}${o.label}`,
    `${o.label} has failed every attempt since ${chileStamp(streak.failing_since)} ` +
      `(${hoursText(failingForMs)}, ${streak.failures} attempts).\nLast error: ${o.message}\n` +
      `The sync keeps retrying while the source is stale; this notification is repeated once a day until it succeeds.`
  );
  db.prepare(`UPDATE sync_source_failure_streaks SET notified_at = ? WHERE source = ?`).run(at, o.source);
}

function recordSuccess(o: SyncSourceOutcome & { ok: true }): void {
  const streak = syncSourceFailureStreak(o.source);
  if (!streak) return;
  db.prepare(`DELETE FROM sync_source_failure_streaks WHERE source = ?`).run(o.source);
  insertAppMessage(
    streak.notified_at != null ? "notification" : "log",
    `${SYNC_SOURCE_RECOVERED_TITLE_PREFIX}${o.label}`,
    `${o.label} synced again at ${chileStamp(sqliteUtc(o.at))} after failing since ${chileStamp(streak.failing_since)} ` +
      `(${streak.failures} attempts).\nLast error: ${streak.last_error}`
  );
}

/** Apply one sync run's step outcomes, in the order the steps ran. */
export function recordSyncSourceOutcomes(outcomes: readonly SyncSourceOutcome[], opts: { dryRun: boolean }): void {
  if (opts.dryRun || outcomes.length === 0) return;
  const disabled = deploymentProfile().disabledSyncSources;
  db.transaction(() => {
    for (const o of outcomes) {
      if (disabled.has(o.source)) continue;
      if (o.ok) recordSuccess(o);
      else recordFailure(o);
    }
  })();
}
