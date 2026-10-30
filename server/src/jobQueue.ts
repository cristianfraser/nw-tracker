import { db } from "./db.js";
import { coalesceQueued, type JobStatus, type QueuedJob, type RunningJob } from "./jobQueuePolicy.js";

/**
 * The `jobs` table (migration 246, docs/job-queue-plan.md): enqueue (coalescing by dedupe key),
 * claim, heartbeat, complete. Every state change is a single guarded UPDATE in an IMMEDIATE
 * transaction, so a job starts at most once per attempt whoever races for it. Which job may start
 * is `pickNextJobs`' call, never this module's.
 */

/** How each kind of job behaves in the queue. */
export type JobKindDefinition = {
  priority: number;
  resources: readonly string[];
  /** A running job silent for this long is `lost`. */
  lease_ms: number;
  max_attempts: number;
  /** `executor`: the server dispatches it. `claim`: an outside worker claims it (the deploy agent). */
  dispatch: "executor" | "claim";
};

export const JOB_KINDS = {
  "ingest.nightly": { priority: 50, resources: ["ingest-service"], lease_ms: 5 * 60_000, max_attempts: 1, dispatch: "executor" },
  "ingest.hourly": { priority: 40, resources: ["ingest-service"], lease_ms: 5 * 60_000, max_attempts: 1, dispatch: "executor" },
  deploy: { priority: 100, resources: ["server-restart"], lease_ms: 20 * 60_000, max_attempts: 1, dispatch: "claim" },
} as const satisfies Record<string, JobKindDefinition>;

export type JobKind = keyof typeof JOB_KINDS;

export function isJobKind(kind: string): kind is JobKind {
  return Object.hasOwn(JOB_KINDS, kind);
}

export type JobRow = {
  id: number;
  kind: string;
  dedupe_key: string | null;
  payload_json: string;
  status: JobStatus;
  priority: number;
  not_before: string | null;
  stale_after: string | null;
  resources_json: string;
  worker: string | null;
  claimed_at: string | null;
  heartbeat_at: string | null;
  lease_ms: number;
  attempt: number;
  max_attempts: number;
  enqueued_by: string;
  reason: string;
  result_json: string | null;
  error: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
};

export type EnqueueJob = {
  kind: JobKind;
  dedupe_key: string | null;
  payload: unknown;
  enqueued_by: string;
  reason: string;
  not_before?: Date | null;
  stale_after?: Date | null;
};

function resources(row: JobRow): string[] {
  const parsed: unknown = JSON.parse(row.resources_json);
  if (!Array.isArray(parsed) || !parsed.every((r) => typeof r === "string")) {
    throw new Error(`Job ${row.id} has unreadable resources: ${row.resources_json}`);
  }
  return parsed;
}

export function jobPayload<T = unknown>(row: JobRow): T {
  return JSON.parse(row.payload_json) as T;
}

export function jobById(id: number): JobRow | null {
  return (db.prepare(`SELECT * FROM jobs WHERE id = ?`).get(id) as JobRow | undefined) ?? null;
}

function queuedByDedupeKey(key: string): JobRow | null {
  return (db.prepare(`SELECT * FROM jobs WHERE status = 'queued' AND dedupe_key = ?`).get(key) as JobRow | undefined) ?? null;
}

/**
 * Add a job, or update the queued job with the same dedupe key (`coalesceQueued`). A running job
 * with that key is left alone: the new one queues behind it.
 */
export function enqueueJob(input: EnqueueJob, now: Date): { job: JobRow; coalesced: boolean } {
  const def: JobKindDefinition = JOB_KINDS[input.kind];
  const incoming = {
    payload_json: JSON.stringify(input.payload ?? {}),
    reason: input.reason,
    enqueued_by: input.enqueued_by,
    priority: def.priority,
    not_before: input.not_before ? input.not_before.toISOString() : null,
    stale_after: input.stale_after ? input.stale_after.toISOString() : null,
  };
  return db.transaction(() => {
    const existing = input.dedupe_key ? queuedByDedupeKey(input.dedupe_key) : null;
    if (existing) {
      const merged = coalesceQueued(existing, incoming);
      db.prepare(
        `UPDATE jobs SET payload_json = ?, reason = ?, enqueued_by = ?, priority = ?, not_before = ?, stale_after = ?
         WHERE id = ? AND status = 'queued'`
      ).run(merged.payload_json, merged.reason, merged.enqueued_by, merged.priority, merged.not_before, merged.stale_after, existing.id);
      return { job: jobById(existing.id)!, coalesced: true };
    }
    const row = db
      .prepare(
        `INSERT INTO jobs (kind, dedupe_key, payload_json, status, priority, not_before, stale_after, resources_json,
           lease_ms, max_attempts, enqueued_by, reason, created_at)
         VALUES (?, ?, ?, 'queued', ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`
      )
      .get(
        input.kind,
        input.dedupe_key,
        incoming.payload_json,
        incoming.priority,
        incoming.not_before,
        incoming.stale_after,
        JSON.stringify(def.resources),
        def.lease_ms,
        def.max_attempts,
        incoming.enqueued_by,
        incoming.reason,
        now.toISOString()
      ) as { id: number };
    return { job: jobById(row.id)!, coalesced: false };
  }).immediate();
}

export function listJobsByStatus(status: JobStatus): JobRow[] {
  return db.prepare(`SELECT * FROM jobs WHERE status = ? ORDER BY id`).all(status) as JobRow[];
}

export function queuedForPolicy(rows: readonly JobRow[]): QueuedJob[] {
  return rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    priority: r.priority,
    not_before: r.not_before,
    stale_after: r.stale_after,
    resources: resources(r),
    created_at: r.created_at,
  }));
}

export function runningForPolicy(rows: readonly JobRow[]): RunningJob[] {
  return rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    resources: resources(r),
    claimed_at: r.claimed_at,
    heartbeat_at: r.heartbeat_at,
    lease_ms: r.lease_ms,
  }));
}

/** queued → running for `worker`. False when someone else got there first (or it is no longer queued). */
export function claimJob(id: number, worker: string, now: Date): boolean {
  const at = now.toISOString();
  return (
    db
      .prepare(
        `UPDATE jobs SET status = 'running', worker = ?, claimed_at = ?, heartbeat_at = ?, started_at = ?, error = NULL
         WHERE id = ? AND status = 'queued'`
      )
      .run(worker, at, at, at, id).changes === 1
  );
}

/** A running job's worker is alive. False when the job is not running (finished, written off as lost). */
export function heartbeatJob(id: number, now: Date): boolean {
  return db.prepare(`UPDATE jobs SET heartbeat_at = ? WHERE id = ? AND status = 'running'`).run(now.toISOString(), id).changes === 1;
}

/**
 * running → queued: the worker never took it (the ingest service was busy or did not answer).
 * Not an attempt; it starts again from `notBefore`.
 */
export function releaseJob(id: number, notBefore: Date, error: string): void {
  const changes = db
    .prepare(
      `UPDATE jobs SET status = 'queued', worker = NULL, claimed_at = NULL, heartbeat_at = NULL, started_at = NULL,
         not_before = ?, error = ?
       WHERE id = ? AND status = 'running'`
    )
    .run(notBefore.toISOString(), error, id).changes;
  if (changes !== 1) throw new Error(`Job ${id} is not running; cannot release it`);
}

/**
 * The worker's report. Accepted for a running job, for one written off as lost (a late report —
 * the work did happen), and for one released back to the queue after a request whose answer was
 * lost (the worker took it after all). Any other state throws.
 */
export function completeJob(id: number, outcome: { ok: boolean; result?: unknown; error?: string | null }, now: Date): JobRow {
  const job = jobById(id);
  if (!job) throw new Error(`No job ${id}`);
  if (job.status !== "running" && job.status !== "lost" && job.status !== "queued") {
    throw new Error(`Job ${id} is ${job.status}, not waiting for a report`);
  }
  db.prepare(
    `UPDATE jobs SET status = ?, result_json = ?, error = ?, finished_at = ?, started_at = COALESCE(started_at, ?)
     WHERE id = ?`
  ).run(
    outcome.ok ? "done" : "failed",
    outcome.result === undefined ? null : JSON.stringify(outcome.result),
    outcome.error ?? null,
    now.toISOString(),
    now.toISOString(),
    id
  );
  return jobById(id)!;
}

export function markJobLost(id: number, now: Date, error: string): boolean {
  return (
    db
      .prepare(`UPDATE jobs SET status = 'lost', error = ?, finished_at = ? WHERE id = ? AND status = 'running'`)
      .run(error, now.toISOString(), id).changes === 1
  );
}

export function supersedeJob(id: number, now: Date, error: string): boolean {
  return (
    db
      .prepare(`UPDATE jobs SET status = 'superseded', error = ?, finished_at = ? WHERE id = ? AND status = 'queued'`)
      .run(error, now.toISOString(), id).changes === 1
  );
}

/** Only a queued job can be cancelled: a running one is in a worker's hands. */
export function cancelJob(id: number, now: Date): boolean {
  return (
    db
      .prepare(`UPDATE jobs SET status = 'cancelled', error = 'cancelled by hand', finished_at = ? WHERE id = ? AND status = 'queued'`)
      .run(now.toISOString(), id).changes === 1
  );
}

/** The latest finished jobs, newest first. */
export function listRecentFinishedJobs(limit: number): JobRow[] {
  return db
    .prepare(`SELECT * FROM jobs WHERE status NOT IN ('queued', 'running') ORDER BY COALESCE(finished_at, created_at) DESC, id DESC LIMIT ?`)
    .all(limit) as JobRow[];
}
