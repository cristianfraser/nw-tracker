/**
 * What the job queue may start now (docs/job-queue-plan.md) — a pure decision over the queued and
 * running jobs, unit-tested like `decideIngestRun`. The executor (`jobQueueExecutor.ts`) and the
 * claim endpoint act on it; nothing else decides.
 *
 * - A running job whose worker has not heartbeated within its lease is `lost`: it holds nothing.
 * - A queued job past its `stale_after` is superseded, never started.
 * - Queued jobs are considered by priority (higher first), then `not_before`, then age.
 * - A job starts only when none of its resources is held by a running job (or by a job granted
 *   earlier in the same pass).
 * - `server-restart` is exclusive: it is granted only when nothing else runs, nothing else starts
 *   while it is held, and once a job needing it is due, nothing of lower priority starts either —
 *   the queue drains so the restart is not starved by a fresh hourly poll every hour.
 */

export const JOB_STATUSES = ["queued", "running", "done", "failed", "cancelled", "superseded", "lost"] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

/** Held by a job that restarts the server: every other job must be idle. */
export const EXCLUSIVE_RESOURCE = "server-restart";

export type QueuedJob = {
  id: number;
  kind: string;
  priority: number;
  not_before: string | null;
  stale_after: string | null;
  resources: readonly string[];
  created_at: string;
};

export type RunningJob = {
  id: number;
  kind: string;
  resources: readonly string[];
  claimed_at: string | null;
  heartbeat_at: string | null;
  lease_ms: number;
};

/** Why a queued job did not start: structured, so the client words it (i18n). */
export type JobWaitReason =
  | { code: "not_before"; at: string }
  | { code: "resource"; resource: string; held_by: { id: number; kind: string } }
  | { code: "exclusive"; held_by: { id: number; kind: string } }
  | { code: "draining"; for_job: { id: number; kind: string } };

export type JobQueueDecision = {
  /** Queued jobs that may start now, in start order. */
  start: QueuedJob[];
  waiting: { job: QueuedJob; reason: JobWaitReason }[];
  superseded: QueuedJob[];
  /** Running jobs whose lease ran out. */
  lost: RunningJob[];
};

function ms(iso: string): number {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) throw new Error(`Not an instant: ${iso}`);
  return t;
}

/** The instant a running job's lease runs out: its last heartbeat (or its claim) + lease. */
export function leaseExpiresAt(job: RunningJob): number {
  const last = job.heartbeat_at ?? job.claimed_at;
  if (!last) throw new Error(`Running job ${job.id} has neither a claim nor a heartbeat`);
  return ms(last) + job.lease_ms;
}

function compareQueued(a: QueuedJob, b: QueuedJob): number {
  if (a.priority !== b.priority) return b.priority - a.priority;
  const an = a.not_before ?? "";
  const bn = b.not_before ?? "";
  if (an !== bn) return an < bn ? -1 : 1;
  if (a.created_at !== b.created_at) return a.created_at < b.created_at ? -1 : 1;
  return a.id - b.id;
}

export function pickNextJobs(queue: readonly QueuedJob[], running: readonly RunningJob[], now: Date): JobQueueDecision {
  const t = now.getTime();
  const lost = running.filter((j) => leaseExpiresAt(j) <= t);
  const live = running.filter((j) => leaseExpiresAt(j) > t);

  type Ref = { id: number; kind: string };
  const state: { held: Map<string, Ref>; exclusive: Ref | null; busy: Ref | null; draining: Ref | null } = {
    held: new Map(),
    exclusive: null,
    busy: null,
    draining: null,
  };
  const hold = (job: { id: number; kind: string; resources: readonly string[] }) => {
    const ref = { id: job.id, kind: job.kind };
    state.busy ??= ref;
    for (const r of job.resources) {
      if (!state.held.has(r)) state.held.set(r, ref);
      if (r === EXCLUSIVE_RESOURCE) state.exclusive = ref;
    }
  };
  for (const j of live) hold(j);

  const decision: JobQueueDecision = { start: [], waiting: [], superseded: [], lost };

  for (const job of [...queue].sort(compareQueued)) {
    if (job.stale_after != null && ms(job.stale_after) <= t) {
      decision.superseded.push(job);
      continue;
    }
    const wait = (reason: JobWaitReason) => decision.waiting.push({ job, reason });
    if (state.exclusive) {
      wait({ code: "exclusive", held_by: state.exclusive });
      continue;
    }
    if (state.draining) {
      wait({ code: "draining", for_job: state.draining });
      continue;
    }
    if (job.not_before != null && ms(job.not_before) > t) {
      wait({ code: "not_before", at: job.not_before });
      continue;
    }
    if (job.resources.includes(EXCLUSIVE_RESOURCE)) {
      state.draining = { id: job.id, kind: job.kind };
      if (state.busy) {
        wait({ code: "resource", resource: EXCLUSIVE_RESOURCE, held_by: state.busy });
        continue;
      }
      decision.start.push(job);
      hold(job);
      continue;
    }
    const conflict = job.resources.find((r) => state.held.has(r));
    if (conflict) {
      wait({ code: "resource", resource: conflict, held_by: state.held.get(conflict)! });
      continue;
    }
    decision.start.push(job);
    hold(job);
  }
  return decision;
}

/**
 * Enqueuing a job whose dedupe key is already queued updates that row instead (`jobQueue.ts`):
 * the newest payload and reason win, it may start as early as either asked, at the higher of the
 * two priorities, and goes stale when the newer one says.
 */
export type CoalescedFields = {
  payload_json: string;
  reason: string;
  enqueued_by: string;
  priority: number;
  not_before: string | null;
  stale_after: string | null;
};

export function coalesceQueued(existing: CoalescedFields, incoming: CoalescedFields): CoalescedFields {
  const notBefore =
    existing.not_before == null || incoming.not_before == null
      ? null
      : existing.not_before < incoming.not_before
        ? existing.not_before
        : incoming.not_before;
  return {
    payload_json: incoming.payload_json,
    reason: incoming.reason,
    enqueued_by: incoming.enqueued_by,
    priority: Math.max(existing.priority, incoming.priority),
    not_before: notBefore,
    stale_after: incoming.stale_after,
  };
}
