import {
  liderStateSchema,
  santanderStateSchema,
  type IngestRunCompletion,
  type IngestRunKind,
  type IngestRunRequest,
  type LiderState,
  type SantanderState,
} from "nw-tracker-contracts";
import { recordDailyRun, recordHourlyEmailRun, type DailyRunStep } from "./dailyRunLog.js";
import { db } from "./db.js";
import { completeJob, jobById } from "./jobQueue.js";

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
  santander_request: "balance-poll" | "catch-up" | "payday" | null;
  santander_request_reason: string | null;
  santander_outcome: "ok" | "failed" | "vetoed" | null;
  santander_note: string | null;
  santander_state_json: string | null;
  activity: number | null;
  dry_run: number | null;
  /** The queue job that ran it (docs/job-queue-plan.md); null for runs from before the queue. */
  job_id: number | null;
  /** The run asked for a read of the mortgage lender's portal (migration 308). */
  metlife_request: "quote" | "posted" | null;
  metlife_request_reason: string | null;
  /** The hourly poll asked for a Lider BCI read (migration 327); null on the nightly, which always reads it. */
  lider_request: "poll" | null;
  lider_request_reason: string | null;
  lider_outcome: "ok" | "failed" | "turnstile" | "vetoed" | null;
  lider_note: string | null;
  lider_state_json: string | null;
};

function parseInstant(value: string | null | undefined): Date | null {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Latest slot a queue job of `kind` was enqueued for (any status: a queued job waits, a cancelled one was meant to skip). */
export function lastJobSlot(kind: IngestRunKind): Date | null {
  const row = db
    .prepare(`SELECT MAX(json_extract(payload_json, '$.slot')) AS s FROM jobs WHERE kind = ?`)
    .get(`ingest.${kind}`) as { s: string | null };
  return parseInstant(row.s);
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

/**
 * The ingest run of queue job `jobId`'s slot, as requested (a retry of a slot that never started —
 * the service busy or silent — reuses its row, so the service sees the same run id again).
 */
export function markIngestRunRequested(
  kind: IngestRunKind,
  slot: Date,
  reason: string,
  now: Date,
  santanderFetch: IngestRunRequest["santander_fetch"],
  jobId: number,
  metlifeRead: IngestRunRequest["metlife_read"] = null,
  liderFetch: IngestRunRequest["lider_fetch"] = null
): number {
  const row = db
    .prepare(
      `INSERT INTO ingest_runs (kind, slot_at, status, reason, requested_at, santander_request, santander_request_reason, job_id,
                                metlife_request, metlife_request_reason, lider_request, lider_request_reason)
       VALUES (?, ?, 'requested', ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (kind, slot_at) DO UPDATE SET status = 'requested', reason = excluded.reason,
         requested_at = excluded.requested_at, error = NULL, santander_request = excluded.santander_request,
         santander_request_reason = excluded.santander_request_reason, job_id = excluded.job_id,
         metlife_request = excluded.metlife_request, metlife_request_reason = excluded.metlife_request_reason,
         lider_request = excluded.lider_request, lider_request_reason = excluded.lider_request_reason
       RETURNING id`
    )
    .get(
      kind,
      slot.toISOString(),
      reason,
      now.toISOString(),
      santanderFetch?.mode ?? null,
      santanderFetch?.reason ?? null,
      jobId,
      metlifeRead?.mode ?? null,
      metlifeRead?.reason ?? null,
      liderFetch ? "poll" : null,
      liderFetch?.reason ?? null
    ) as {
    id: number;
  };
  return row.id;
}

/** When the latest run that asked for a mortgage-lender read was requested (one the service took or may take), or null. */
export function lastMetlifeReadRequestedAt(): Date | null {
  const row = db
    .prepare(`SELECT MAX(requested_at) AS t FROM ingest_runs WHERE metlife_request IS NOT NULL AND status <> 'not_started'`)
    .get() as { t: string | null };
  return parseInstant(row.t);
}

/**
 * Queue job `jobId` was written off as lost (its worker stopped heartbeating): its run is lost too,
 * recorded as a failed run like any other. Returns the run, or null when the job had none in flight.
 */
export function markIngestRunLostForJob(jobId: number, error: string): IngestRunRow | null {
  const row = db.prepare(`SELECT * FROM ingest_runs WHERE job_id = ? AND status = 'requested'`).get(jobId) as IngestRunRow | undefined;
  if (!row) return null;
  db.prepare(`UPDATE ingest_runs SET status = 'lost', error = ? WHERE id = ?`).run(error, row.id);
  recordRunMessage(row.kind, [{ label: `${row.kind} run — ${error}`, ok: false, seconds: null }], false);
  return { ...row, status: "lost", error };
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

/** The feeder's Lider BCI facts from the latest run that reported them. */
export function latestLiderState(): LiderState | null {
  const row = db
    .prepare(
      `SELECT lider_state_json AS j FROM ingest_runs
       WHERE lider_state_json IS NOT NULL ORDER BY finished_at DESC, id DESC LIMIT 1`
    )
    .get() as { j: string } | undefined;
  return row ? liderStateSchema.parse(JSON.parse(row.j)) : null;
}

/** The run's app message, as `record:daily-run` / `record:email-run` wrote it for the shell runners. */
function recordRunMessage(kind: IngestRunKind, steps: DailyRunStep[], activity: boolean): void {
  if (kind === "nightly") recordDailyRun(steps);
  else recordHourlyEmailRun(steps, { activity });
}

export function markIngestRunNotStarted(id: number, error: string): void {
  db.prepare(`UPDATE ingest_runs SET status = 'not_started', error = ? WHERE id = ?`).run(error, id);
}

export function markIngestRunSkipped(kind: IngestRunKind, slot: Date, reason: string, jobId: number | null = null): void {
  db.prepare(
    `INSERT INTO ingest_runs (kind, slot_at, status, reason, job_id) VALUES (?, ?, 'skipped', ?, ?)
     ON CONFLICT (kind, slot_at) DO UPDATE SET status = 'skipped', reason = excluded.reason, job_id = excluded.job_id
     WHERE ingest_runs.status IN ('skipped', 'not_started')`
  ).run(kind, slot.toISOString(), reason, jobId);
}

export function ingestRunById(id: number): IngestRunRow | null {
  return (db.prepare(`SELECT * FROM ingest_runs WHERE id = ?`).get(id) as IngestRunRow | undefined) ?? null;
}

/**
 * Record the feeder's report, and the run's app message from it (a dry run records none). Accepted
 * for a requested run; for one marked not started (the feeder took the request but its answer was
 * lost — a timeout); and, late, for one already written off as lost (whose failure message then
 * stands beside the real one). Any other state throws (a report for a run nobody asked for is a bug).
 */
export function completeIngestRun(id: number, completion: IngestRunCompletion): IngestRunRow {
  const row = ingestRunById(id);
  if (!row) throw new Error(`No ingest run ${id}`);
  if (row.status !== "requested" && row.status !== "not_started" && row.status !== "lost") {
    throw new Error(`Ingest run ${id} is ${row.status}, not waiting for a report`);
  }
  const failedSteps = completion.steps ? completion.steps.filter((s) => !s.ok).length : null;
  const ok = completion.exit_code === 0 && (failedSteps ?? 0) === 0 && completion.steps != null;
  db.transaction(() => {
    db.prepare(
      `UPDATE ingest_runs SET status = ?, started_at = ?, finished_at = ?, exit_code = ?, failed_steps = ?,
         steps_json = ?, error = NULL, santander_outcome = ?, santander_note = ?, santander_state_json = ?,
         lider_outcome = ?, lider_note = ?, lider_state_json = ?, activity = ?, dry_run = ?
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
      completion.lider?.outcome ?? null,
      completion.lider?.note ?? null,
      completion.lider_state ? JSON.stringify(completion.lider_state) : null,
      completion.activity ? 1 : 0,
      completion.dry_run ? 1 : 0,
      id
    );
    if (!completion.dry_run) {
      const steps: DailyRunStep[] =
        completion.steps ?? [{ label: `runner reported no steps (exit ${completion.exit_code})`, ok: false, seconds: null }];
      recordRunMessage(row.kind, steps, completion.activity);
    }
    // The run's queue job ends with it (a job already finished — a duplicate report — is left alone).
    if (row.job_id != null) {
      const job = jobById(row.job_id);
      if (job && (job.status === "running" || job.status === "lost" || job.status === "queued")) {
        completeJob(
          row.job_id,
          {
            ok,
            result: { ingest_run_id: id, exit_code: completion.exit_code, failed_steps: failedSteps, dry_run: completion.dry_run },
            error: ok ? null : `exit ${completion.exit_code}, ${failedSteps ?? "?"} failed step(s)`,
          },
          new Date()
        );
      }
    }
  })();
  return ingestRunById(id)!;
}

export function listRecentIngestRuns(limit = 50): IngestRunRow[] {
  return db.prepare(`SELECT * FROM ingest_runs ORDER BY slot_at DESC, id DESC LIMIT ?`).all(limit) as IngestRunRow[];
}

/** The latest run of `kind` that was started (requested, finished or written off) — not a skipped slot. */
export function latestStartedIngestRun(kind: IngestRunKind): IngestRunRow | null {
  return (
    (db
      .prepare(
        `SELECT * FROM ingest_runs WHERE kind = ? AND status IN ('requested', 'done', 'failed', 'lost')
         ORDER BY requested_at DESC, id DESC LIMIT 1`
      )
      .get(kind) as IngestRunRow | undefined) ?? null
  );
}
