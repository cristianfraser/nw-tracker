import { ingestJobSlot, ingestSchedulerEnabled, MANUAL_ENQUEUED_BY, enqueueIngestRun } from "./ingestRunScheduler.js";
import { markIngestRunSkipped } from "./ingestRuns.js";
import { currentJobQueueDecision } from "./jobQueueExecutor.js";
import { cancelJob, jobById, listJobsByStatus, listRecentFinishedJobs, type JobRow } from "./jobQueue.js";
import { leaseExpiresAt, type JobWaitReason } from "./jobQueuePolicy.js";
import { db } from "./db.js";
import { notifyJobQueue } from "./jobQueueSignal.js";

/**
 * The job queue as the import sync page shows it (docs/job-queue-plan.md, phase 4): what runs,
 * what waits and why, recent history, and which actions each row allows. The server words
 * nothing: the wait reason is structured and the client translates it.
 */

/** A job kind as an i18n slug (`ingest.nightly` → `ingest_nightly`): i18n keys cannot hold dots. */
function kindSlug(kind: string): string {
  return kind.replace(/\./g, "_");
}

export type JobWaitView =
  | { code: "not_before"; at: string }
  | { code: "resource"; resource: string; held_by: { id: number; kind_slug: string } }
  | { code: "exclusive"; held_by: { id: number; kind_slug: string } }
  | { code: "draining"; for_job: { id: number; kind_slug: string } };

export type JobView = {
  id: number;
  kind_slug: string;
  status: JobRow["status"];
  reason: string;
  enqueued_by: string;
  resources: string[];
  worker: string | null;
  created_at: string;
  not_before: string | null;
  started_at: string | null;
  finished_at: string | null;
  heartbeat_at: string | null;
  lease_expires_at: string | null;
  error: string | null;
  waiting: JobWaitView | null;
  /** The ingest run this job is (its outcome), when it has one. */
  ingest_run: { id: number; status: string; failed_steps: number | null } | null;
  can_cancel: boolean;
  can_retry: boolean;
};

export type JobQueuePayload = {
  scheduler_enabled: boolean;
  running: JobView[];
  queued: JobView[];
  recent: JobView[];
};

function waitView(r: JobWaitReason): JobWaitView {
  switch (r.code) {
    case "not_before":
      return r;
    case "resource":
      return { code: "resource", resource: r.resource, held_by: { id: r.held_by.id, kind_slug: kindSlug(r.held_by.kind) } };
    case "exclusive":
      return { code: "exclusive", held_by: { id: r.held_by.id, kind_slug: kindSlug(r.held_by.kind) } };
    case "draining":
      return { code: "draining", for_job: { id: r.for_job.id, kind_slug: kindSlug(r.for_job.kind) } };
  }
}

function isIngestKind(kind: string): boolean {
  return kind === "ingest.nightly" || kind === "ingest.hourly";
}

function ingestRunsByJob(ids: number[]): Map<number, { id: number; status: string; failed_steps: number | null }> {
  if (!ids.length) return new Map();
  const rows = db
    .prepare(`SELECT id, job_id, status, failed_steps FROM ingest_runs WHERE job_id IN (${ids.map(() => "?").join(",")}) ORDER BY id`)
    .all(...ids) as { id: number; job_id: number; status: string; failed_steps: number | null }[];
  return new Map(rows.map((r) => [r.job_id, { id: r.id, status: r.status, failed_steps: r.failed_steps }]));
}

export function buildJobQueuePayload(now: Date, recentLimit = 20): JobQueuePayload {
  const decision = currentJobQueueDecision(now);
  const waiting = new Map(decision.waiting.map((w) => [w.job.id, w.reason]));
  const running = listJobsByStatus("running");
  const queued = listJobsByStatus("queued");
  const recent = listRecentFinishedJobs(recentLimit);
  const runs = ingestRunsByJob([...running, ...queued, ...recent].map((j) => j.id));
  const schedulerOn = ingestSchedulerEnabled();
  const view = (j: JobRow): JobView => ({
    id: j.id,
    kind_slug: kindSlug(j.kind),
    status: j.status,
    reason: j.reason,
    enqueued_by: j.enqueued_by,
    resources: JSON.parse(j.resources_json) as string[],
    worker: j.worker,
    created_at: j.created_at,
    not_before: j.not_before,
    started_at: j.started_at,
    finished_at: j.finished_at,
    heartbeat_at: j.heartbeat_at,
    lease_expires_at:
      j.status === "running"
        ? new Date(leaseExpiresAt({ id: j.id, kind: j.kind, resources: [], claimed_at: j.claimed_at, heartbeat_at: j.heartbeat_at, lease_ms: j.lease_ms })).toISOString()
        : null,
    error: j.error,
    waiting: j.status === "queued" && waiting.has(j.id) ? waitView(waiting.get(j.id)!) : null,
    ingest_run: runs.get(j.id) ?? null,
    can_cancel: j.status === "queued",
    can_retry: schedulerOn && isIngestKind(j.kind) && (j.status === "failed" || j.status === "lost"),
  });
  return { scheduler_enabled: schedulerOn, running: running.map(view), queued: queued.map(view), recent: recent.map(view) };
}

export type JobActionOutcome = { ok: true } | { ok: false; status: 404 | 409; message: string };

/** Cancel a queued job (a running one is in a worker's hands). A cancelled slot is not queued again. */
export function cancelQueuedJob(id: number, now: Date): JobActionOutcome {
  const job = jobById(id);
  if (!job) return { ok: false, status: 404, message: `No job ${id}` };
  if (!cancelJob(id, now)) return { ok: false, status: 409, message: `Job ${id} is ${job.status}; only a queued job can be cancelled` };
  if (isIngestKind(job.kind)) markIngestRunSkipped(job.kind === "ingest.nightly" ? "nightly" : "hourly", ingestJobSlot(job), "cancelled by hand", id);
  console.log(`job-queue: ${job.kind} job ${id} cancelled by hand`);
  notifyJobQueue();
  return { ok: true };
}

/** Queue a failed or lost ingest run again, as a manual run (it starts as soon as the service is free). */
export function retryJob(id: number, now: Date): JobActionOutcome {
  const job = jobById(id);
  if (!job) return { ok: false, status: 404, message: `No job ${id}` };
  if (!isIngestKind(job.kind) || (job.status !== "failed" && job.status !== "lost")) {
    return { ok: false, status: 409, message: `Job ${id} (${job.kind}, ${job.status}) cannot be retried; only a failed or lost ingest run can` };
  }
  if (!ingestSchedulerEnabled()) return { ok: false, status: 409, message: "The ingest scheduler is off on this server instance." };
  const { job: queued } = enqueueIngestRun(job.kind === "ingest.nightly" ? "nightly" : "hourly", now, `manual: retry of job ${id}`, MANUAL_ENQUEUED_BY, now);
  console.log(`job-queue: ${job.kind} job ${id} retried as job ${queued.id}`);
  return { ok: true };
}
