import {
  FEEDER_RUNS_PATH,
  feederAlreadyRanSchema,
  feederBusySchema,
  ingestRunRequestSchema,
  type IngestRunKind,
  type IngestRunRequest,
} from "nw-tracker-contracts";
import { insertAppMessage } from "./appMessages.js";
import { backgroundJobsDisabled } from "./backgroundJobsEnv.js";
import { ingestFeederHeaders, resolveIngestServiceUrl } from "./ingestFeeder.js";
import { DAILY_RUN_REPEAT_WINDOW_MINUTES, lastDailyRunAt } from "./dailyRunLog.js";
import {
  decideAfcFetch,
  decideAfpUnoFetch,
  decideIngestRun,
  decideMortgageSheetRun,
  decidePayslipsRun,
  decideSantanderFetch,
  type IngestSchedulerDecision,
} from "./ingestRunPolicy.js";
import { latestRegularMortgageCuotaPaidOn } from "./mortgageSheetPaymentsApply.js";
import { latestPayslip, latestSalaryPayslipPeriod } from "./payslipsApply.js";
import { latestUnemploymentFundContributionPeriod } from "./unemploymentFundBalanceApply.js";
import {
  lastAnsweredSlot,
  lastCatchUpAttemptAt,
  lastJobSlot,
  lastPaydayAttemptYmd,
  latestSantanderState,
  markIngestRunNotStarted,
  markIngestRunRequested,
  markIngestRunSkipped,
} from "./ingestRuns.js";
import { claimJob, enqueueJob, jobPayload, releaseJob, supersedeJob, type JobRow } from "./jobQueue.js";
import { notifyJobQueue } from "./jobQueueSignal.js";

/**
 * The server's side of the run protocol (docs/ingest-split-plan.md, Phase 2; through the job
 * queue since docs/job-queue-plan.md, phase 2): every tick reads the wall clock, `ingest_runs` and
 * the queue, lets `decideIngestRun` pick the slot that is due, and queues it; the executor
 * dispatches it to the ingest service (`dispatchIngestJob`). A fixed-interval tick, not a timer set for 22:00: timers stall while
 * the machine sleeps, the wall clock does not, so the first tick after a wake sees the missed
 * slot. Off unless `INGEST_SCHEDULER_ENABLED=1`, which only the primary instance's LaunchAgent
 * sets (never the root `.env`, which every dev server loads).
 */

const TICK_MS = 30_000;
const REQUEST_TIMEOUT_MS = 10_000;
export const INGEST_UNREACHABLE_TITLE = "Ingest service unreachable";
/** The worker name of jobs the ingest service runs. */
export const INGEST_SERVICE_WORKER = "ingest-service";

/**
 * On only with `INGEST_SCHEDULER_ENABLED=1`, and never on an instance with
 * `BACKGROUND_JOBS_ENABLED=0` whatever else says so: a second scheduler would start every
 * bank run twice.
 */
export function ingestSchedulerEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.INGEST_SCHEDULER_ENABLED === "1" && !backgroundJobsDisabled(env);
}


function storedUtc(value: string | null): Date | null {
  if (!value) return null;
  const d = new Date(`${value.trim().replace(" ", "T")}Z`);
  return Number.isNaN(d.getTime()) ? null : d;
}

export type FeederAnswer =
  | { status: "accepted" }
  | { status: "busy"; detail: string }
  | { status: "unreachable"; detail: string };

/** POST the run request to the ingest service. Never throws: every failure is an answer. */
export async function requestFeederRun(request: IngestRunRequest, env: NodeJS.ProcessEnv = process.env): Promise<FeederAnswer> {
  const runId = request.run_id;
  try {
    const res = await fetch(`${resolveIngestServiceUrl(env)}${FEEDER_RUNS_PATH}`, {
      method: "POST",
      headers: ingestFeederHeaders(env),
      body: JSON.stringify(ingestRunRequestSchema.parse(request)),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (res.status === 202) return { status: "accepted" };
    const text = await res.text();
    if (res.status === 409) {
      let parsed: unknown = null;
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = null;
      }
      // The feeder is running, or already ran, THIS run: the answer to an earlier request with
      // the same id was lost (a timeout), and its report will come.
      if (feederAlreadyRanSchema.safeParse(parsed).success) return { status: "accepted" };
      const busy = feederBusySchema.safeParse(parsed);
      if (busy.success && busy.data.running.run_id === runId) return { status: "accepted" };
      return {
        status: "busy",
        detail: busy.success
          ? `running a ${busy.data.running.kind} run since ${busy.data.running.started_at}`
          : text.slice(0, 200),
      };
    }
    return { status: "unreachable", detail: `HTTP ${res.status}: ${text.slice(0, 200)}` };
  } catch (err) {
    const cause = err instanceof Error && err.cause instanceof Error ? err.cause.message : "";
    return { status: "unreachable", detail: [err instanceof Error ? err.message : String(err), cause].filter(Boolean).join(" — ") };
  }
}

type RunRequestExtras = {
  santanderFetch: IngestRunRequest["santander_fetch"];
  afpUnoFetch: IngestRunRequest["afp_uno_fetch"];
  afcFetch: IngestRunRequest["afc_fetch"];
  payslips: IngestRunRequest["payslips"];
  mortgageSheet: IngestRunRequest["mortgage_sheet"];
};

/** What a run of `kind` requested now carries besides its kind: the same rules for a slot and a manual run. */
function runRequestExtras(kind: IngestRunKind, now: Date): RunRequestExtras {
  return {
    // An hourly poll may carry the one bank fetch the rules allow (catch-up, else payday).
    santanderFetch:
      kind === "hourly"
        ? decideSantanderFetch({
            now,
            state: latestSantanderState(),
            lastCatchUpAttemptAt: lastCatchUpAttemptAt(),
            lastPaydayAttemptYmd: lastPaydayAttemptYmd(),
          })
        : null,
    // Every nightly reads AFP UNO's balance; the read fetches the certificates when its cuotas moved.
    afpUnoFetch: kind === "nightly" ? decideAfpUnoFetch() : null,
    // A nightly reads the AFC from the 14th after a payroll month until its contribution is in.
    afcFetch:
      kind === "nightly"
        ? decideAfcFetch({ now, latestSalaryPayslipPeriod: latestSalaryPayslipPeriod(), latestContributionPeriod: latestUnemploymentFundContributionPeriod() })
        : null,
    // A nightly reads the payroll portal from the 1st until last month's payslip is stored, and
    // re-imports while the newest payslip waits for its deposit.
    payslips: kind === "nightly" ? decidePayslipsRun({ now, latest: latestPayslip() }) : null,
    // Either kind reads the mortgage sheet while the cycle's cuota is not in the ledger (from the 11th).
    mortgageSheet: decideMortgageSheetRun({ now, latestCuotaPaidOn: latestRegularMortgageCuotaPaidOn() }),
  };
}

function extrasNote(e: RunRequestExtras): string {
  return (
    (e.santanderFetch ? `; Santander ${e.santanderFetch.mode}: ${e.santanderFetch.reason}` : "") +
    (e.afpUnoFetch ? `; AFP UNO: ${e.afpUnoFetch.reason}` : "") +
    (e.afcFetch ? `; AFC: ${e.afcFetch.reason}` : "") +
    (e.payslips ? `; payslips: ${e.payslips.reason}` : "") +
    (e.mortgageSheet ? `; mortgage sheet: ${e.mortgageSheet.reason}` : "")
  );
}

export const SCHEDULER_ENQUEUED_BY = "scheduler";
export const MANUAL_ENQUEUED_BY = "manual";
export const MANUAL_RUN_REASON = "manual: requested from the import sync page";
const HOUR_MS = 3_600_000;
/** A run the service did not take (busy, or silent) is offered again after this long. */
export const INGEST_DISPATCH_RETRY_MS = TICK_MS;

/** What an ingest job carries: the slot it answers (a manual run's is the request instant). */
export type IngestJobPayload = { slot: string };

function jobKindFor(kind: IngestRunKind): "ingest.nightly" | "ingest.hourly" {
  return kind === "nightly" ? "ingest.nightly" : "ingest.hourly";
}

function ingestKindOfJob(job: JobRow): IngestRunKind {
  if (job.kind === "ingest.nightly") return "nightly";
  if (job.kind === "ingest.hourly") return "hourly";
  throw new Error(`Job ${job.id} (${job.kind}) is not an ingest run`);
}

export function ingestJobSlot(job: JobRow): Date {
  const slot = jobPayload<IngestJobPayload>(job).slot;
  const d = new Date(slot);
  if (typeof slot !== "string" || Number.isNaN(d.getTime())) throw new Error(`Ingest job ${job.id} has no slot: ${job.payload_json}`);
  return d;
}

/**
 * Queue an ingest run (one queued job per kind: a slot enqueued while the previous one still
 * waits is absorbed by it). A scheduled hourly goes stale at the next slot; a nightly and a manual
 * run wait however long it takes.
 */
export function enqueueIngestRun(kind: IngestRunKind, slot: Date, reason: string, enqueuedBy: string, now: Date): { job: JobRow; coalesced: boolean } {
  const out = enqueueJob(
    {
      kind: jobKindFor(kind),
      dedupe_key: jobKindFor(kind),
      payload: { slot: slot.toISOString() } satisfies IngestJobPayload,
      enqueued_by: enqueuedBy,
      reason,
      not_before: slot,
      stale_after: kind === "hourly" && enqueuedBy === SCHEDULER_ENQUEUED_BY ? new Date(slot.getTime() + HOUR_MS) : null,
    },
    now
  );
  notifyJobQueue();
  return out;
}

function laterOf(a: Date | null, b: Date | null): Date | null {
  if (!a) return b;
  if (!b) return a;
  return a.getTime() >= b.getTime() ? a : b;
}

export type IngestTickOutcome = {
  decision: IngestSchedulerDecision;
  job_id: number | null;
};

/**
 * One scheduling step: decide which slot is due and queue it. The executor (`jobQueueExecutor.ts`)
 * starts it when the ingest service is free; a slot that cannot start yet waits, never dropped.
 */
export function ingestSchedulerTick(now: Date): IngestTickOutcome {
  const decision = decideIngestRun({
    now,
    lastNightlySlot: laterOf(lastAnsweredSlot("nightly"), lastJobSlot("nightly")),
    lastHourlySlot: laterOf(lastAnsweredSlot("hourly"), lastJobSlot("hourly")),
    lastDailyRunAt: storedUtc(lastDailyRunAt()),
  });
  if (decision.action === "idle") return { decision, job_id: null };
  if (decision.action === "skip") {
    markIngestRunSkipped(decision.kind, decision.slot, decision.reason);
    console.log(`ingest-runs: ${decision.kind} slot ${decision.slot.toISOString()} skipped — ${decision.reason}`);
    return { decision, job_id: null };
  }
  const { job, coalesced } = enqueueIngestRun(decision.kind, decision.slot, decision.reason, SCHEDULER_ENQUEUED_BY, now);
  console.log(
    `ingest-runs: ${decision.kind} slot ${decision.slot.toISOString()} ${coalesced ? `absorbed by queued job ${job.id}` : `queued as job ${job.id}`} (${decision.reason})`
  );
  return { decision, job_id: job.id };
}

/**
 * Whether a scheduled job's slot was already covered by a nightly run recorded since it was queued
 * (the rules `decideIngestRun` applies at enqueue time, applied again at start: a run started by
 * hand, or one the job waited behind). A manual job always runs.
 */
function coveredByDailyRun(job: JobRow, kind: IngestRunKind, slot: Date, now: Date): string | null {
  if (job.enqueued_by !== SCHEDULER_ENQUEUED_BY) return null;
  const last = storedUtc(lastDailyRunAt());
  if (!last) return null;
  if (kind === "nightly") {
    if (last.getTime() >= slot.getTime()) return `a daily run finished at ${last.toISOString()}, after the slot`;
    const since = now.getTime() - last.getTime();
    if (since >= 0 && since < DAILY_RUN_REPEAT_WINDOW_MINUTES * 60_000) return `a daily run finished ${Math.round(since / 60_000)} min ago`;
    return null;
  }
  return last.getTime() > slot.getTime() ? `the nightly run that finished at ${last.toISOString()} covered it` : null;
}

export type IngestDispatchContext = {
  request: (request: IngestRunRequest) => Promise<FeederAnswer>;
  /** Slots that already raised the unreachable notification or were logged, so a service that stays down badges once per slot. */
  notified: Set<string>;
};

export type IngestDispatchOutcome = "started" | "superseded" | "released" | "not_claimed";

/**
 * Start queue job `job` (an ingest run `pickNextJobs` let start): claim it, write its run (the
 * request extras — Santander catch-up / payday, AFP, AFC, payslips, mortgage sheet — decided now,
 * at start, from the state as it is now) and hand it to the ingest service. A service that is busy
 * or does not answer gets it back in the queue, offered again shortly.
 */
export async function dispatchIngestJob(job: JobRow, now: Date, ctx: IngestDispatchContext): Promise<IngestDispatchOutcome> {
  const kind = ingestKindOfJob(job);
  const slot = ingestJobSlot(job);
  const covered = coveredByDailyRun(job, kind, slot, now);
  if (covered) {
    if (supersedeJob(job.id, now, covered)) {
      markIngestRunSkipped(kind, slot, covered, job.id);
      console.log(`ingest-runs: ${kind} job ${job.id} (slot ${slot.toISOString()}) superseded — ${covered}`);
    }
    return "superseded";
  }
  if (!claimJob(job.id, INGEST_SERVICE_WORKER, now)) return "not_claimed";
  const extras = runRequestExtras(kind, now);
  const runId = markIngestRunRequested(kind, slot, job.reason, now, extras.santanderFetch, job.id);
  const answer = await ctx.request({
    run_id: runId,
    job_id: job.id,
    kind,
    reason: job.reason,
    santander_fetch: extras.santanderFetch,
    afp_uno_fetch: extras.afpUnoFetch,
    afc_fetch: extras.afcFetch,
    payslips: extras.payslips,
    mortgage_sheet: extras.mortgageSheet,
  });
  if (answer.status === "accepted") {
    console.log(`ingest-runs: ${kind} run ${runId} (job ${job.id}) started (${job.reason}${extrasNote(extras)})`);
    return "started";
  }
  const detail = `${answer.status}: ${answer.detail}`;
  releaseJob(job.id, new Date(now.getTime() + INGEST_DISPATCH_RETRY_MS), detail);
  markIngestRunNotStarted(runId, detail);
  const slotKey = `${kind}|${slot.toISOString()}`;
  // A timeout right after a wake is usually the feeder answering late; the next attempt (same run
  // id) sorts it out, so only a second unreachable answer for the slot raises the notification.
  const firstUnreachable = answer.status === "unreachable" && !ctx.notified.has(`unreachable|${slotKey}`);
  if (answer.status === "unreachable") ctx.notified.add(`unreachable|${slotKey}`);
  if (answer.status === "unreachable" && !firstUnreachable && kind === "nightly" && !ctx.notified.has(slotKey)) {
    ctx.notified.add(slotKey);
    insertAppMessage(
      "notification",
      INGEST_UNREACHABLE_TITLE,
      `The ${kind} run for ${slot.toISOString()} could not start: the ingest service at ${resolveIngestServiceUrl()} ` +
        `did not answer (${answer.detail}). It stays queued and is offered again every ${INGEST_DISPATCH_RETRY_MS / 1000} s; ` +
        `check the com.user.nw-tracker-ingest LaunchAgent.`
    );
  }
  if (!ctx.notified.has(`logged|${slotKey}|${answer.status}`)) {
    ctx.notified.add(`logged|${slotKey}|${answer.status}`);
    console.log(`ingest-runs: ${kind} run ${runId} (job ${job.id}) not started — ${detail} (stays queued)`);
  }
  return "released";
}

export type ManualIngestRunOutcome =
  | { status: "queued"; job_id: number; coalesced: boolean }
  | { status: "refused"; reason: "scheduler_off"; message: string };

/**
 * Run the hourly poll or the nightly now, outside its slot — a mail that just landed, a fetch to
 * retry. It is queued like any other run (slot = the request instant, `not_before` = now) and
 * starts as soon as the ingest service is free; a run of the same kind already queued is moved up
 * instead. Only the instance whose scheduler is on may queue: the feeder reports to the primary
 * server. A slot a manual run overlaps is answered by it: an hourly at 14:40 answers the 14:30
 * slot, and a nightly that just finished makes the 22:00 slot skip (the one-hour repeat window).
 */
export function startManualIngestRun(kind: IngestRunKind, now: Date, env: NodeJS.ProcessEnv = process.env): ManualIngestRunOutcome {
  if (!ingestSchedulerEnabled(env)) {
    return {
      status: "refused",
      reason: "scheduler_off",
      message: "The ingest scheduler is off on this server instance (INGEST_SCHEDULER_ENABLED); only the primary instance can start a run.",
    };
  }
  const { job, coalesced } = enqueueIngestRun(kind, now, MANUAL_RUN_REASON, MANUAL_ENQUEUED_BY, now);
  console.log(`ingest-runs: manual ${kind} run ${coalesced ? `moved up queued job ${job.id}` : `queued as job ${job.id}`}`);
  return { status: "queued", job_id: job.id, coalesced };
}

let started = false;

/** The producer: every tick, queue the slot that is due. The executor starts the jobs. */
export function startIngestRunScheduler(): void {
  if (started || !ingestSchedulerEnabled()) return;
  started = true;
  const tick = () => {
    try {
      ingestSchedulerTick(new Date());
    } catch (err) {
      console.log(`ingest-runs: tick failed — ${err instanceof Error ? err.message : String(err)}`);
    }
  };
  console.log(`ingest-runs: scheduler on (tick ${TICK_MS / 1000} s; runs go through the job queue)`);
  tick();
  setInterval(tick, TICK_MS).unref();
}
