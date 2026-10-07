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
import { lastDailyRunAt } from "./dailyRunLog.js";
import { decideAfpUnoFetch, decideIngestRun, decidePayslipsRun, decideSantanderFetch, type IngestSchedulerDecision } from "./ingestRunPolicy.js";
import { latestPayslip } from "./payslipsApply.js";
import {
  inFlightIngestRun,
  lastAnsweredSlot,
  lastCatchUpAttemptAt,
  lastPaydayAttemptYmd,
  latestSantanderState,
  markIngestRunNotStarted,
  markIngestRunRequested,
  markIngestRunSkipped,
  sweepLostIngestRuns,
} from "./ingestRuns.js";

/**
 * The server's side of the run protocol (docs/ingest-split-plan.md, Phase 2): every tick reads
 * the wall clock and `ingest_runs`, lets `decideIngestRun` pick the one thing to do, and asks the
 * ingest service to run it. A fixed-interval tick, not a timer set for 22:00: timers stall while
 * the machine sleeps, the wall clock does not, so the first tick after a wake sees the missed
 * slot. Off unless `INGEST_SCHEDULER_ENABLED=1`, which only the primary instance's LaunchAgent
 * sets (never the root `.env`, which every dev server loads).
 */

const TICK_MS = 30_000;
const REQUEST_TIMEOUT_MS = 10_000;
export const INGEST_UNREACHABLE_TITLE = "Ingest service unreachable";

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
export async function requestFeederRun(
  runId: number,
  kind: IngestRunKind,
  reason: string,
  santanderFetch: IngestRunRequest["santander_fetch"],
  afpUnoFetch: IngestRunRequest["afp_uno_fetch"] = null,
  env: NodeJS.ProcessEnv = process.env,
  payslips: IngestRunRequest["payslips"] = null
): Promise<FeederAnswer> {
  try {
    const res = await fetch(`${resolveIngestServiceUrl(env)}${FEEDER_RUNS_PATH}`, {
      method: "POST",
      headers: ingestFeederHeaders(env),
      body: JSON.stringify(
        ingestRunRequestSchema.parse({ run_id: runId, kind, reason, santander_fetch: santanderFetch, afp_uno_fetch: afpUnoFetch, payslips })
      ),
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

export type IngestTickOutcome = {
  decision: IngestSchedulerDecision;
  run_id: number | null;
  answer: FeederAnswer | null;
};

/**
 * One scheduling step. `notifiedSlots` remembers which nightly slots already raised the
 * unreachable notification, so a service that stays down badges once per slot, not per tick.
 */
export async function ingestSchedulerTick(
  now: Date,
  notifiedSlots: Set<string>,
  request: typeof requestFeederRun = requestFeederRun
): Promise<IngestTickOutcome> {
  for (const lost of sweepLostIngestRuns(now)) {
    console.log(`ingest-runs: ${lost.kind} run ${lost.id} (slot ${lost.slot_at}) sent no report — written off as lost`);
  }
  const inFlight = inFlightIngestRun();
  const decision = decideIngestRun({
    now,
    lastNightlySlot: lastAnsweredSlot("nightly"),
    lastHourlySlot: lastAnsweredSlot("hourly"),
    lastDailyRunAt: storedUtc(lastDailyRunAt()),
    inFlight: inFlight ? { kind: inFlight.kind } : null,
  });
  if (decision.action === "idle" || decision.action === "wait") {
    return { decision, run_id: null, answer: null };
  }
  if (decision.action === "skip") {
    markIngestRunSkipped(decision.kind, decision.slot, decision.reason);
    console.log(`ingest-runs: ${decision.kind} slot ${decision.slot.toISOString()} skipped — ${decision.reason}`);
    return { decision, run_id: null, answer: null };
  }
  // An hourly poll may carry the one bank fetch the rules allow (catch-up, else payday).
  const santanderFetch =
    decision.kind === "hourly"
      ? decideSantanderFetch({
          now,
          state: latestSantanderState(),
          lastCatchUpAttemptAt: lastCatchUpAttemptAt(),
          lastPaydayAttemptYmd: lastPaydayAttemptYmd(),
        })
      : null;
  // Every nightly reads AFP UNO's balance; the read fetches the certificates when its cuotas moved.
  const afpUnoFetch = decision.kind === "nightly" ? decideAfpUnoFetch() : null;
  // A nightly reads the payroll portal from the 1st until last month's payslip is stored, and
  // re-imports while the newest payslip waits for its deposit.
  const payslips = decision.kind === "nightly" ? decidePayslipsRun({ now, latest: latestPayslip() }) : null;
  const runId = markIngestRunRequested(decision.kind, decision.slot, decision.reason, now, santanderFetch);
  const answer = await request(runId, decision.kind, decision.reason, santanderFetch, afpUnoFetch, undefined, payslips);
  if (answer.status === "accepted") {
    const fetchNote =
      (santanderFetch ? `; Santander ${santanderFetch.mode}: ${santanderFetch.reason}` : "") +
      (afpUnoFetch ? `; AFP UNO: ${afpUnoFetch.reason}` : "") +
      (payslips ? `; payslips: ${payslips.reason}` : "");
    console.log(`ingest-runs: ${decision.kind} run ${runId} started (${decision.reason}${fetchNote})`);
    return { decision, run_id: runId, answer };
  }
  markIngestRunNotStarted(runId, `${answer.status}: ${answer.detail}`);
  const slotKey = `${decision.kind}|${decision.slot.toISOString()}`;
  // A timeout right after a wake is usually the feeder answering late; the next tick (same run id)
  // sorts it out, so only a second unreachable answer for the slot raises the notification.
  const firstUnreachable = answer.status === "unreachable" && !notifiedSlots.has(`unreachable|${slotKey}`);
  if (answer.status === "unreachable") notifiedSlots.add(`unreachable|${slotKey}`);
  if (answer.status === "unreachable" && !firstUnreachable && decision.kind === "nightly" && !notifiedSlots.has(slotKey)) {
    notifiedSlots.add(slotKey);
    insertAppMessage(
      "notification",
      INGEST_UNREACHABLE_TITLE,
      `The ${decision.kind} run for ${decision.slot.toISOString()} could not start: the ingest service ` +
        `at ${resolveIngestServiceUrl()} did not answer (${answer.detail}). The server keeps retrying ` +
        `every ${TICK_MS / 1000} s; check the com.user.nw-tracker-ingest LaunchAgent.`
    );
  }
  if (!notifiedSlots.has(`logged|${slotKey}|${answer.status}`)) {
    notifiedSlots.add(`logged|${slotKey}|${answer.status}`);
    console.log(
      `ingest-runs: ${decision.kind} run ${runId} not started — ${answer.status}: ${answer.detail}` +
        (decision.kind === "nightly" ? " (retrying)" : " (hour given up)")
    );
  }
  return { decision, run_id: runId, answer };
}

let started = false;

export function startIngestRunScheduler(): void {
  if (started || !ingestSchedulerEnabled()) return;
  started = true;
  const notified = new Set<string>();
  let ticking = false;
  const tick = () => {
    if (ticking) return;
    ticking = true;
    ingestSchedulerTick(new Date(), notified)
      .catch((err) => console.log(`ingest-runs: tick failed — ${err instanceof Error ? err.message : String(err)}`))
      .finally(() => {
        ticking = false;
      });
  };
  console.log(`ingest-runs: scheduler on (service ${resolveIngestServiceUrl()}, tick ${TICK_MS / 1000} s)`);
  tick();
  setInterval(tick, TICK_MS).unref();
}
