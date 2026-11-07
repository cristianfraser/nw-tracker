import { insertAppMessage } from "./appMessages.js";
import { serverConfig } from "./config.js";
import { dispatchIngestJob, ingestJobSlot, requestFeederRun, type IngestDispatchContext } from "./ingestRunScheduler.js";
import { markIngestRunLostForJob, markIngestRunSkipped } from "./ingestRuns.js";
import {
  JOB_KINDS,
  ingestRunKindOfJob,
  isJobKind,
  jobById,
  listJobsByStatus,
  markJobLost,
  queuedForPolicy,
  runningForPolicy,
  supersedeJob,
  type JobKind,
  type JobRow,
} from "./jobQueue.js";
import { pickNextJobs, type JobQueueDecision } from "./jobQueuePolicy.js";
import { onJobQueueChange } from "./jobQueueSignal.js";
import { ScheduledJob, atStartThen, nextAlignedMs } from "./schedulerKernel.js";

/**
 * The job queue's executor (docs/job-queue-plan.md), a job on the scheduler kernel: every 30 s on
 * the wall clock, and at once when a producer enqueues or a worker completes (`notifyJobQueue`;
 * a change during a run runs it once more right after), it asks `pickNextJobs` what may start and
 * acts on it — writes off jobs whose lease ran out, supersedes stale ones, and dispatches the jobs
 * the server starts itself (`JOB_DISPATCHERS`). Jobs an outside worker claims (a deploy) are never
 * dispatched here: the claim endpoint grants them (`jobClaims.ts`). On with
 * `JOB_QUEUE_EXECUTOR_ENABLED`, which defaults to the ingest scheduler's flag (`config.ts`) — the
 * primary instance.
 */

const TICK_MS = 30_000;

export type JobQueueTickContext = IngestDispatchContext;

type ExecutorJobKind = { [K in JobKind]: (typeof JOB_KINDS)[K]["dispatch"] extends "executor" ? K : never }[JobKind];

/** How the executor starts each kind it dispatches itself: one entry per `executor` kind of `JOB_KINDS`. */
const JOB_DISPATCHERS: { readonly [K in ExecutorJobKind]: (job: JobRow, now: Date, ctx: JobQueueTickContext) => Promise<unknown> } = {
  "ingest.nightly": dispatchIngestJob,
  "ingest.hourly": dispatchIngestJob,
};

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

function writeOffLost(job: JobRow, now: Date): void {
  const minutes = Math.round(job.lease_ms / 60_000);
  const error = `no heartbeat from ${job.worker ?? "its worker"} for ${minutes} min`;
  if (!markJobLost(job.id, now, error)) return;
  console.log(`job-queue: ${job.kind} job ${job.id} written off as lost — ${error}`);
  if (ingestRunKindOfJob(job.kind)) {
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
  const ingestKind = ingestRunKindOfJob(job.kind);
  if (ingestKind) markIngestRunSkipped(ingestKind, ingestJobSlot(job), `superseded while queued (${job.reason})`, job.id);
}

/** One executor step. Returns the decision it acted on. */
export async function jobQueueTick(now: Date, ctx: JobQueueTickContext): Promise<JobQueueDecision> {
  const decision = currentJobQueueDecision(now);
  for (const j of decision.lost) writeOffLost(jobById(j.id)!, now);
  for (const j of decision.superseded) writeOffStale(jobById(j.id)!, now);
  for (const j of decision.start) {
    const job = jobById(j.id)!;
    if (!isJobKind(job.kind)) throw new Error(`Job ${job.id} has an unknown kind: ${job.kind}`);
    const kind = job.kind;
    if (JOB_KINDS[kind].dispatch === "claim") continue;
    await JOB_DISPATCHERS[kind as ExecutorJobKind](job, now, ctx);
  }
  return decision;
}

const ctx: JobQueueTickContext = { request: (r) => requestFeederRun(r), notified: new Set() };
let lastLine = "";

const executorJob = new ScheduledJob({
  name: "job-queue",
  enabled: () => serverConfig().jobQueueExecutor,
  next: atStartThen((nowMs) => nextAlignedMs(nowMs, TICK_MS)),
  whileRunning: "again",
  run: async () => {
    try {
      const line = describeJobQueueDecision(await jobQueueTick(new Date(), ctx));
      if (line !== lastLine && line !== "idle") console.log(`job-queue: ${line}`);
      lastLine = line;
      return "ok";
    } catch (err) {
      console.log(`job-queue: tick failed — ${err instanceof Error ? err.message : String(err)}`);
      return "failed";
    }
  },
});

export function startJobQueueExecutor(): void {
  if (executorJob.isEnabled || !executorJob.start()) return;
  onJobQueueChange(() => setImmediate(() => executorJob.trigger()));
  console.log(`job-queue: executor on (tick ${TICK_MS / 1000} s)`);
}
