import {
  santanderStateSchema,
  type IngestRunCompletion,
  type IngestRunKind,
  type IngestRunRequest,
  type SantanderState,
} from "nw-tracker-contracts";
import { chileWallClockAt } from "./chileDate.js";
import { recordDailyRun, recordHourlyEmailRun, type DailyRunStep } from "./dailyRunLog.js";
import { db } from "./db.js";

/**
 * The `ingest_runs` table (migration 200): the scheduler's memory of each slot. Instants are
 * stored as ISO UTC strings (`toISOString()`), so they compare as text.
 */

export type IngestRunStatus = "requested" | "done" | "failed" | "lost" | "skipped" | "not_started";

export type IngestRunRow = {
  id: number;
  kind: IngestRunKind;
  slot_at: string;
  status: IngestRunStatus;
  reason: string;
  requested_at: string | null;
  started_at: string | null;
  finished_at: string | null;
  exit_code: number | null;
  failed_steps: number | null;
  steps_json: string | null;
  error: string | null;
  santander_request: "catch-up" | "payday" | null;
  santander_request_reason: string | null;
  santander_outcome: "ok" | "failed" | "vetoed" | null;
  santander_note: string | null;
  santander_state_json: string | null;
  activity: number | null;
  dry_run: number | null;
};

/** A run that has not reported back after this long is written off as `lost`. */
export const INGEST_RUN_TIMEOUT_MS: Readonly<Record<IngestRunKind, number>> = {
  nightly: 3 * 3_600_000,
  hourly: 90 * 60_000,
};

function parseInstant(value: string | null | undefined): Date | null {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Latest slot a row answers: any status for the hourly poll, anything that started for the nightly. */
export function lastAnsweredSlot(kind: IngestRunKind): Date | null {
  const row = db
    .prepare(
      kind === "nightly"
        ? `SELECT MAX(slot_at) AS s FROM ingest_runs WHERE kind = 'nightly' AND status <> 'not_started'`
        : `SELECT MAX(slot_at) AS s FROM ingest_runs WHERE kind = 'hourly'`
    )
    .get() as { s: string | null };
  return parseInstant(row.s);
}

export function inFlightIngestRun(): IngestRunRow | null {
  return (
    (db.prepare(`SELECT * FROM ingest_runs WHERE status = 'requested' ORDER BY requested_at DESC LIMIT 1`).get() as
      | IngestRunRow
      | undefined) ?? null
  );
}

/** Write off requested runs older than their kind's timeout. Returns the rows written off. */
export function sweepLostIngestRuns(now: Date): IngestRunRow[] {
  const lost: IngestRunRow[] = [];
  for (const row of db.prepare(`SELECT * FROM ingest_runs WHERE status = 'requested'`).all() as IngestRunRow[]) {
    const requested = parseInstant(row.requested_at);
    if (requested && now.getTime() - requested.getTime() > INGEST_RUN_TIMEOUT_MS[row.kind]) {
      const error = `no report within ${INGEST_RUN_TIMEOUT_MS[row.kind] / 60_000} min`;
      db.prepare(`UPDATE ingest_runs SET status = 'lost', error = ? WHERE id = ?`).run(error, row.id);
      // The run never said how it went: that is a failed run, badged like any other.
      recordRunMessage(row.kind, [{ label: `${row.kind} run — ${error} from the ingest service`, ok: false, seconds: null }], false);
      lost.push({ ...row, status: "lost" });
    }
  }
  return lost;
}

/** Claim a slot as requested (a retry of a slot that never started reuses its row). */
export function markIngestRunRequested(
  kind: IngestRunKind,
  slot: Date,
  reason: string,
  now: Date,
  santanderFetch: IngestRunRequest["santander_fetch"] = null
): number {
  const row = db
    .prepare(
      `INSERT INTO ingest_runs (kind, slot_at, status, reason, requested_at, santander_request, santander_request_reason)
       VALUES (?, ?, 'requested', ?, ?, ?, ?)
       ON CONFLICT (kind, slot_at) DO UPDATE SET status = 'requested', reason = excluded.reason,
         requested_at = excluded.requested_at, error = NULL, santander_request = excluded.santander_request,
         santander_request_reason = excluded.santander_request_reason
       RETURNING id`
    )
    .get(kind, slot.toISOString(), reason, now.toISOString(), santanderFetch?.mode ?? null, santanderFetch?.reason ?? null) as {
    id: number;
  };
  return row.id;
}

/** The feeder's bank facts from the latest run that reported them. */
export function latestSantanderState(): SantanderState | null {
  const row = db
    .prepare(
      `SELECT santander_state_json AS j FROM ingest_runs
       WHERE santander_state_json IS NOT NULL ORDER BY finished_at DESC, id DESC LIMIT 1`
    )
    .get() as { j: string } | undefined;
  return row ? santanderStateSchema.parse(JSON.parse(row.j)) : null;
}

/**
 * Bank fetches this scheduler asked an hourly poll for that count as attempted: the poll took the
 * run and did not decline the fetch (a run still in flight, or lost, counts — one bank login per
 * slot is the point, and an unknown outcome may have been one).
 */
function attemptedFetchRequests(mode: "catch-up" | "payday"): { requested_at: string }[] {
  return db
    .prepare(
      `SELECT requested_at FROM ingest_runs
       WHERE santander_request = ? AND status IN ('requested', 'done', 'failed', 'lost')
         AND (santander_outcome IS NULL OR santander_outcome <> 'vetoed')
       ORDER BY requested_at DESC LIMIT 1`
    )
    .all(mode) as { requested_at: string }[];
}

export function lastCatchUpAttemptAt(): Date | null {
  return parseInstant(attemptedFetchRequests("catch-up")[0]?.requested_at);
}

export function lastPaydayAttemptYmd(): string | null {
  const at = parseInstant(attemptedFetchRequests("payday")[0]?.requested_at);
  return at ? chileWallClockAt(at).ymd : null;
}

/** The run's app message, as `record:daily-run` / `record:email-run` wrote it for the shell runners. */
function recordRunMessage(kind: IngestRunKind, steps: DailyRunStep[], activity: boolean): void {
  if (kind === "nightly") recordDailyRun(steps);
  else recordHourlyEmailRun(steps, { activity });
}

export function markIngestRunNotStarted(id: number, error: string): void {
  db.prepare(`UPDATE ingest_runs SET status = 'not_started', error = ? WHERE id = ?`).run(error, id);
}

export function markIngestRunSkipped(kind: IngestRunKind, slot: Date, reason: string): void {
  db.prepare(
    `INSERT INTO ingest_runs (kind, slot_at, status, reason) VALUES (?, ?, 'skipped', ?)
     ON CONFLICT (kind, slot_at) DO UPDATE SET status = 'skipped', reason = excluded.reason`
  ).run(kind, slot.toISOString(), reason);
}

export function ingestRunById(id: number): IngestRunRow | null {
  return (db.prepare(`SELECT * FROM ingest_runs WHERE id = ?`).get(id) as IngestRunRow | undefined) ?? null;
}

/**
 * Record the feeder's report, and the run's app message from it (a dry run records none). Accepted
 * for a requested run and, late, for one already written off as lost (whose failure message then
 * stands beside the real one); any other state throws (a report for a run nobody asked for is a bug).
 */
export function completeIngestRun(id: number, completion: IngestRunCompletion): IngestRunRow {
  const row = ingestRunById(id);
  if (!row) throw new Error(`No ingest run ${id}`);
  if (row.status !== "requested" && row.status !== "lost") {
    throw new Error(`Ingest run ${id} is ${row.status}, not waiting for a report`);
  }
  const failedSteps = completion.steps ? completion.steps.filter((s) => !s.ok).length : null;
  const ok = completion.exit_code === 0 && (failedSteps ?? 0) === 0 && completion.steps != null;
  db.transaction(() => {
    db.prepare(
      `UPDATE ingest_runs SET status = ?, started_at = ?, finished_at = ?, exit_code = ?, failed_steps = ?,
         steps_json = ?, error = NULL, santander_outcome = ?, santander_note = ?, santander_state_json = ?,
         activity = ?, dry_run = ?
       WHERE id = ?`
    ).run(
      ok ? "done" : "failed",
      completion.started_at,
      completion.finished_at,
      completion.exit_code,
      failedSteps,
      completion.steps ? JSON.stringify(completion.steps) : null,
      completion.santander?.outcome ?? null,
      completion.santander?.note ?? null,
      JSON.stringify(completion.santander_state),
      completion.activity ? 1 : 0,
      completion.dry_run ? 1 : 0,
      id
    );
    if (!completion.dry_run) {
      const steps: DailyRunStep[] =
        completion.steps ?? [{ label: `runner reported no steps (exit ${completion.exit_code})`, ok: false, seconds: null }];
      recordRunMessage(row.kind, steps, completion.activity);
    }
  })();
  return ingestRunById(id)!;
}

export function listRecentIngestRuns(limit = 50): IngestRunRow[] {
  return db.prepare(`SELECT * FROM ingest_runs ORDER BY slot_at DESC, id DESC LIMIT ?`).all(limit) as IngestRunRow[];
}
