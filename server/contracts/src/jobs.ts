/**
 * The job queue's worker side (docs/job-queue-plan.md): a worker holding a running job tells the
 * server it is alive, or the job's lease runs out and it is written off as lost.
 *
 *   worker → server  POST /api/jobs/<job_id>/heartbeat     → 200 | 409 job_not_running
 */

export const JOBS_API_PATH = "/api/jobs";

/** How often a worker heartbeats; the ingest jobs' lease is five of these. */
export const JOB_HEARTBEAT_INTERVAL_MS = 60_000;

export function jobHeartbeatPath(jobId: number): string {
  return `${JOBS_API_PATH}/${jobId}/heartbeat`;
}
