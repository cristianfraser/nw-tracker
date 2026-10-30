import { ingestSchedulerEnabled } from "./ingestRunScheduler.js";
import { listJobsByStatus, queuedForPolicy, runningForPolicy } from "./jobQueue.js";
import { pickNextJobs, type JobQueueDecision } from "./jobQueuePolicy.js";

/**
 * The job queue's executor (docs/job-queue-plan.md). Phase 1: shadow mode — every tick it asks
 * `pickNextJobs` what the queue would start and logs it when that changes; the ingest scheduler
 * still dispatches the runs itself. Runs on the instance whose ingest scheduler is on.
 */

const TICK_MS = 30_000;

/** One line per decision, so the log shows what changed between ticks. */
export function describeJobQueueDecision(d: JobQueueDecision): string {
  const parts = [
    ...d.start.map((j) => `start ${j.kind} ${j.id}`),
    ...d.waiting.map((w) => `wait ${w.job.kind} ${w.job.id} (${w.reason.code})`),
    ...d.superseded.map((j) => `supersede ${j.kind} ${j.id}`),
    ...d.lost.map((j) => `lost ${j.kind} ${j.id}`),
  ];
  return parts.length ? parts.join("; ") : "idle";
}

export function shadowJobQueueTick(now: Date): JobQueueDecision {
  return pickNextJobs(queuedForPolicy(listJobsByStatus("queued")), runningForPolicy(listJobsByStatus("running")), now);
}

let started = false;

export function startJobQueueExecutor(): void {
  if (started || !ingestSchedulerEnabled()) return;
  started = true;
  let last = "";
  const tick = () => {
    try {
      const line = describeJobQueueDecision(shadowJobQueueTick(new Date()));
      if (line !== last) console.log(`job-queue (shadow): ${line}`);
      last = line;
    } catch (err) {
      console.log(`job-queue (shadow): tick failed — ${err instanceof Error ? err.message : String(err)}`);
    }
  };
  console.log(`job-queue: executor on in shadow mode (tick ${TICK_MS / 1000} s)`);
  tick();
  setInterval(tick, TICK_MS).unref();
}
