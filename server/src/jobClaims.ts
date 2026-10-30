import type { ClaimedJobKind, JobCompleteRequest, JobEnqueueRequest } from "nw-tracker-contracts";
import { currentJobQueueDecision } from "./jobQueueExecutor.js";
import { JOB_KINDS, claimJob, completeJob, enqueueJob, isJobKind, jobById, listJobsByStatus, type JobRow } from "./jobQueue.js";
import { describeJobWait } from "./jobQueuePolicy.js";
import { notifyJobQueue } from "./jobQueueSignal.js";

/**
 * Jobs an outside worker runs (docs/job-queue-plan.md): today the deploy agent
 * (`scripts/server-deploy.sh`). It enqueues, then claims; the claim is granted only when
 * `pickNextJobs` would start the job — for a deploy, when nothing else runs (`server-restart`).
 */

/**
 * A waiting deploy is re-enqueued by the agent on every run (every 3 minutes); one the agent
 * stopped asking for goes stale after this long, so a dead agent cannot hold the queue drained.
 */
export const DEPLOY_STALE_AFTER_MS = 15 * 60_000;

export type DeployJobPayload = { sha: string };

export function enqueueDeploy(request: JobEnqueueRequest, now: Date): { job: JobRow; coalesced: boolean } {
  const out = enqueueJob(
    {
      kind: "deploy",
      dedupe_key: "deploy",
      payload: { sha: request.sha } satisfies DeployJobPayload,
      enqueued_by: "deploy-agent",
      reason: request.reason,
      stale_after: new Date(now.getTime() + DEPLOY_STALE_AFTER_MS),
    },
    now
  );
  notifyJobQueue();
  return out;
}

export type ClaimAnswer = { job: JobRow | null; waiting: string | null };

/** Claim the queued job of `kind` if the queue lets it start now; otherwise say why it waits. */
export function claimNextJob(kind: ClaimedJobKind, worker: string, now: Date): ClaimAnswer {
  const decision = currentJobQueueDecision(now);
  const grant = decision.start.find((j) => j.kind === kind);
  if (grant && claimJob(grant.id, worker, now)) {
    console.log(`job-queue: ${kind} job ${grant.id} claimed by ${worker}`);
    notifyJobQueue();
    return { job: jobById(grant.id), waiting: null };
  }
  const wait = decision.waiting.find((w) => w.job.kind === kind);
  if (wait) return { job: null, waiting: describeJobWait(wait.reason) };
  if (decision.superseded.some((j) => j.kind === kind)) return { job: null, waiting: "the queued job went stale" };
  const running = listJobsByStatus("running").find((j) => j.kind === kind);
  return { job: null, waiting: running ? `${kind} job ${running.id} is already running` : `no ${kind} job is queued` };
}

/** The outside worker's report. Only for kinds an outside worker claims; ingest runs report through their run. */
export function completeClaimedJob(id: number, request: JobCompleteRequest, now: Date): JobRow {
  const job = jobById(id);
  if (!job) throw new Error(`No job ${id}`);
  if (!isJobKind(job.kind) || JOB_KINDS[job.kind].dispatch !== "claim") {
    throw new Error(`Job ${id} (${job.kind}) is not completed by an outside worker`);
  }
  const done = completeJob(id, { ok: request.ok, result: request.result ?? undefined, error: request.error }, now);
  console.log(`job-queue: ${job.kind} job ${id} ${done.status}${request.error ? ` — ${request.error}` : ""}`);
  notifyJobQueue();
  return done;
}
