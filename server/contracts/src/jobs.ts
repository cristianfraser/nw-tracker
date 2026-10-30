import { z } from "zod";

/**
 * The job queue's worker side (docs/job-queue-plan.md). A worker holding a running job tells the
 * server it is alive, or the job's lease runs out and it is written off as lost. A worker outside
 * the server (the deploy agent) enqueues its job, claims it when the queue grants it, and
 * completes it.
 *
 *   worker → server  POST /api/jobs                      JobEnqueueRequest  → { job }
 *   worker → server  POST /api/jobs/claim                JobClaimRequest    → { job | null, waiting }
 *   worker → server  POST /api/jobs/<job_id>/heartbeat                      → 200 | 409 job_not_running
 *   worker → server  POST /api/jobs/<job_id>/complete    JobCompleteRequest → { job }
 *
 * Ingest runs are not enqueued or completed here: the server queues them itself and their run
 * report (`runs.ts`) completes the job.
 */

export const JOBS_API_PATH = "/api/jobs";

/** How often a worker heartbeats; the ingest jobs' lease is five of these. */
export const JOB_HEARTBEAT_INTERVAL_MS = 60_000;

export function jobHeartbeatPath(jobId: number): string {
  return `${JOBS_API_PATH}/${jobId}/heartbeat`;
}

/** Kinds an outside worker enqueues and claims. */
export const CLAIMED_JOB_KINDS = ["deploy"] as const;
export type ClaimedJobKind = (typeof CLAIMED_JOB_KINDS)[number];

export const jobEnqueueRequestSchema = z
  .object({
    kind: z.literal("deploy"),
    /** The commit to deploy (a full sha); a second enqueue while one waits moves the target. */
    sha: z.string().regex(/^[0-9a-f]{40}$/),
    reason: z.string().min(1),
  })
  .strict();
export type JobEnqueueRequest = z.infer<typeof jobEnqueueRequestSchema>;

export const jobClaimRequestSchema = z.object({ kind: z.enum(CLAIMED_JOB_KINDS), worker: z.string().min(1) }).strict();
export type JobClaimRequest = z.infer<typeof jobClaimRequestSchema>;

export const jobCompleteRequestSchema = z
  .object({ ok: z.boolean(), result: z.record(z.string(), z.unknown()).nullable().default(null), error: z.string().nullable().default(null) })
  .strict();
export type JobCompleteRequest = z.infer<typeof jobCompleteRequestSchema>;
