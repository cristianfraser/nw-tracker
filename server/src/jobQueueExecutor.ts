import { insertAppMessage } from "./appMessages.js";
import {
  dispatchIngestJob,
  ingestJobSlot,
  ingestSchedulerEnabled,
  requestFeederRun,
  type IngestDispatchContext,
} from "./ingestRunScheduler.js";
import { markIngestRunLostForJob, markIngestRunSkipped, sweepLostIngestRuns } from "./ingestRuns.js";
import {
  JOB_KINDS,
  isJobKind,
  jobById,
  listJobsByStatus,
  markJobLost,
  queuedForPolicy,
  runningForPolicy,
  supersedeJob,
  type JobRow,
} from "./jobQueue.js";
import { pickNextJobs, type JobQueueDecision } from "./jobQueuePolicy.js";
import { onJobQueueChange } from "./jobQueueSignal.js";

/**
 * The job queue's executor (docs/job-queue-plan.md): every tick, and at once when a producer
 * enqueues or a worker completes (`notifyJobQueue`), it asks `pickNextJobs` what may start and
 * acts on it — writes off jobs whose lease ran out, supersedes stale ones, and dispatches the
 * jobs the server starts itself (the ingest runs, to the ingest service). Jobs an outside worker
 * claims (a deploy) are never dispatched here: the claim endpoint grants them (`jobClaims.ts`).
 * Runs on the instance whose ingest scheduler is on — the primary.
 */

const TICK_MS = 30_000;

export type JobQueueTickContext = IngestDispatchContext;

/** One line per decision, for the log. */
export function describeJobQueueDecision(d: JobQueueDecision): string {
  const parts = [
    ...d.start.map((j) => `start ${j.kind} ${j.id}`),
    ...d.waiting.map((w) => `wait ${w.job.kind} ${w.job.id} (${w.reason.code})`),
    ...d.superseded.map((j) => `supersede ${j.kind} ${j.id}`),
    ...d.lost.map((j) => `lost ${j.kind} ${j.id}`),
  ];
  return parts.length ? parts.join("; ") : "idle";
}

export function currentJobQueueDecision(now: Date): JobQueueDecision {
  return pickNextJobs(queuedForPolicy(listJobsByStatus("queued")), runningForPolicy(listJobsByStatus("running")), now);
}

function isIngestJob(job: JobRow): boolean {
  return job.kind === "ingest.nightly" || job.kind === "ingest.hourly";
}

function ingestKind(job: JobRow): "nightly" | "hourly" {
  return job.kind === "ingest.nightly" ? "nightly" : "hourly";
}

function writeOffLost(job: JobRow, now: Date): void {
  const minutes = Math.round(job.lease_ms / 60_000);
  const error = `no heartbeat from ${job.worker ?? "its worker"} for ${minutes} min`;
  if (!markJobLost(job.id, now, error)) return;
  console.log(`job-queue: ${job.kind} job ${job.id} written off as lost — ${error}`);
  if (isIngestJob(job)) {
    markIngestRunLostForJob(job.id, error);
    return;
  }
  insertAppMessage(
    "notification",
    `Job lost: ${job.kind}`,
    `The ${job.kind} job ${job.id} (${job.reason}) stopped reporting: ${error}. The queue has moved on; check the worker's log.`
  );
}

function writeOffStale(job: JobRow, now: Date): void {
  const error = "stale: its time passed while it waited";
  if (!supersedeJob(job.id, now, error)) return;
  console.log(`job-queue: ${job.kind} job ${job.id} superseded — ${error}`);
  if (isIngestJob(job)) markIngestRunSkipped(ingestKind(job), ingestJobSlot(job), `superseded while queued (${job.reason})`, job.id);
}

/** One executor step. Returns the decision it acted on. */
export async function jobQueueTick(now: Date, ctx: JobQueueTickContext): Promise<JobQueueDecision> {
  for (const lost of sweepLostIngestRuns(now)) {
    console.log(`ingest-runs: ${lost.kind} run ${lost.id} from before the queue sent no report — written off as lost`);
  }
  const decision = currentJobQueueDecision(now);
  for (const j of decision.lost) writeOffLost(jobById(j.id)!, now);
  for (const j of decision.superseded) writeOffStale(jobById(j.id)!, now);
  for (const j of decision.start) {
    const job = jobById(j.id)!;
    if (!isJobKind(job.kind)) throw new Error(`Job ${job.id} has an unknown kind: ${job.kind}`);
    if (JOB_KINDS[job.kind].dispatch === "claim") continue;
    if (isIngestJob(job)) await dispatchIngestJob(job, now, ctx);
    else throw new Error(`No dispatcher for ${job.kind} job ${job.id}`);
  }
  return decision;
}

let started = false;

export function startJobQueueExecutor(): void {
  if (started || !ingestSchedulerEnabled()) return;
  started = true;
  const ctx: JobQueueTickContext = { request: (r) => requestFeederRun(r), notified: new Set() };
  let ticking = false;
  let again = false;
  let lastLine = "";
  const tick = () => {
    if (ticking) {
      again = true;
      return;
    }
    ticking = true;
    jobQueueTick(new Date(), ctx)
      .then((d) => {
        const line = describeJobQueueDecision(d);
        if (line !== lastLine && line !== "idle") console.log(`job-queue: ${line}`);
        lastLine = line;
      })
      .catch((err) => console.log(`job-queue: tick failed — ${err instanceof Error ? err.message : String(err)}`))
      .finally(() => {
        ticking = false;
        if (again) {
          again = false;
          setImmediate(tick);
        }
      });
  };
  onJobQueueChange(() => setImmediate(tick));
  console.log(`job-queue: executor on (tick ${TICK_MS / 1000} s)`);
  tick();
  setInterval(tick, TICK_MS).unref();
}
