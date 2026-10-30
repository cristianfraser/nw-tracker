import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import express from "express";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createIngestClient,
  type IngestRunCompletion,
  type IngestRunKind,
  type IngestRunRequest,
} from "nw-tracker-contracts";
import { db } from "./db.js";
import {
  INGEST_UNREACHABLE_TITLE,
  MANUAL_RUN_REASON,
  ingestSchedulerEnabled,
  ingestSchedulerTick,
  requestFeederRun,
  startManualIngestRun,
  type FeederAnswer,
} from "./ingestRunScheduler.js";
import { completeIngestRun, ingestRunById, listRecentIngestRuns } from "./ingestRuns.js";
import { heartbeatJob, jobById, listJobsByStatus } from "./jobQueue.js";
import { jobQueueTick } from "./jobQueueExecutor.js";
import { registerIngestRoutes } from "./routes/ingest.js";
import { registerJobRoutes } from "./routes/jobs.js";
import { clearJobs } from "./test/jobQueueTestUtils.js";

/**
 * Far-future clock: every daily run the test DB already holds is long before these slots, so
 * only the rows written here decide. 2099-06-10 is winter in Chile (UTC−4): 22:00 = 02:00Z.
 */
const NIGHTLY = new Date("2099-06-11T02:00:00Z");

type Call = { runId: number; jobId: number | null; kind: IngestRunKind; reason: string; santanderFetch: IngestRunRequest["santander_fetch"] };

/** A stand-in ingest service; `answer` can be changed between steps. */
function fakeFeeder(answer: FeederAnswer) {
  const calls: Call[] = [];
  const feeder = {
    answer,
    calls,
    request: async (r: IngestRunRequest): Promise<FeederAnswer> => {
      calls.push({ runId: r.run_id, jobId: r.job_id, kind: r.kind, reason: r.reason, santanderFetch: r.santander_fetch });
      return feeder.answer;
    },
  };
  return feeder;
}

/** What the server does every 30 s: the scheduler queues what is due, the executor starts what may start. */
async function step(at: string, feeder: ReturnType<typeof fakeFeeder>, notified = new Set<string>()) {
  const now = new Date(at);
  const tick = ingestSchedulerTick(now);
  await jobQueueTick(now, { request: feeder.request, notified });
  return tick;
}

/** The ingest run the service was last asked for. */
function lastRunId(feeder: ReturnType<typeof fakeFeeder>): number {
  const call = feeder.calls.at(-1);
  if (!call) throw new Error("the service was never asked");
  return call.runId;
}

const STATE = {
  last_attempt_at: null,
  last_success_at: null,
  login_latched: false,
  last_catch_up_attempt_at: null,
  last_payday_attempt_ymd: null,
};

/** A report as the runner sends it. */
function report(over: Partial<IngestRunCompletion> = {}): IngestRunCompletion {
  return {
    started_at: "2099-06-11T02:00:11.000Z",
    finished_at: "2099-06-11T02:12:00.000Z",
    exit_code: 0,
    steps: [{ label: "fetch Santander", ok: true, seconds: 400 }],
    dry_run: false,
    activity: false,
    santander: { mode: "nightly", outcome: "ok", note: null },
    santander_state: STATE,
    ...over,
  };
}

/** Run messages this file writes — removed afterwards, whatever the test DB held before. */
let messageIdFloor = 0;

function clear() {
  clearJobs();
  db.prepare(`DELETE FROM ingest_runs`).run();
  db.prepare(`DELETE FROM app_messages WHERE title = ? OR id > ?`).run(INGEST_UNREACHABLE_TITLE, messageIdFloor);
}

function runMessages(): { kind: string; title: string; body: string }[] {
  return db
    .prepare(`SELECT kind, title, body FROM app_messages WHERE id > ? ORDER BY id`)
    .all(messageIdFloor) as { kind: string; title: string; body: string }[];
}

describe("scheduler + executor", () => {
  beforeEach(() => {
    messageIdFloor = (db.prepare(`SELECT COALESCE(MAX(id), 0) AS m FROM app_messages`).get() as { m: number }).m;
    clear();
  });
  afterEach(clear);

  it("queues the nightly and starts it; the hour's poll waits for it instead of being dropped", async () => {
    const feeder = fakeFeeder({ status: "accepted" });
    const first = await step("2099-06-11T02:00:10Z", feeder);
    expect(first.decision).toMatchObject({ action: "request", kind: "nightly", slot: NIGHTLY });
    expect(feeder.calls).toEqual([{ runId: expect.any(Number), jobId: first.job_id, kind: "nightly", reason: "22:00 slot, on time", santanderFetch: null }]);
    const runId = lastRunId(feeder);
    expect(ingestRunById(runId)).toMatchObject({ status: "requested", slot_at: NIGHTLY.toISOString(), job_id: first.job_id });
    expect(jobById(first.job_id!)).toMatchObject({ status: "running", worker: "ingest-service" });

    // Same minute: the hour's :30 slot (01:30Z) is queued and waits for the ingest service.
    const second = await step("2099-06-11T02:00:40Z", feeder);
    expect(second.decision).toMatchObject({ action: "request", kind: "hourly" });
    expect(jobById(second.job_id!)).toMatchObject({ status: "queued" });
    expect((await step("2099-06-11T02:01:10Z", feeder)).decision).toEqual({ action: "idle" });
    expect(feeder.calls).toHaveLength(1);

    // The service heartbeats; the nightly reports; the waiting hourly starts.
    heartbeatJob(first.job_id!, new Date("2099-06-11T02:04:00Z"));
    completeIngestRun(runId, report());
    expect(jobById(first.job_id!)).toMatchObject({ status: "done" });
    await step("2099-06-11T02:12:30Z", feeder);
    expect(feeder.calls.at(-1)).toMatchObject({ kind: "hourly", jobId: second.job_id });
  });

  it("an hourly queued past the next slot is absorbed by it: one run, the newer slot", async () => {
    const feeder = fakeFeeder({ status: "accepted" });
    const nightly = await step("2099-06-11T02:00:10Z", feeder);
    const h1 = await step("2099-06-11T02:00:40Z", feeder);
    // The nightly keeps heartbeating for over an hour.
    heartbeatJob(nightly.job_id!, new Date("2099-06-11T02:30:00Z"));
    heartbeatJob(nightly.job_id!, new Date("2099-06-11T02:34:00Z"));
    const h2 = await step("2099-06-11T02:30:05Z", feeder);
    expect(h2.job_id).toBe(h1.job_id);
    expect(listJobsByStatus("queued")).toHaveLength(1);
    expect(JSON.parse(jobById(h1.job_id!)!.payload_json)).toEqual({ slot: "2099-06-11T02:30:00.000Z" });
    completeIngestRun(lastRunId(feeder), report({ finished_at: "2099-06-11T02:35:00.000Z" }));
    await step("2099-06-11T02:35:30Z", feeder);
    expect(feeder.calls.map((c) => c.kind)).toEqual(["nightly", "hourly"]);
    expect(ingestRunById(lastRunId(feeder))).toMatchObject({ slot_at: "2099-06-11T02:30:00.000Z" });
  });

  it("keeps a nightly the service did not take queued, retrying the same run id, badging an outage once", async () => {
    const feeder = fakeFeeder({ status: "unreachable", detail: "fetch failed — connect ECONNREFUSED" });
    const notified = new Set<string>();
    const a = await step("2099-06-11T02:00:10Z", feeder, notified);
    // One unanswered request is not an outage yet (a timeout right after a wake): no badge.
    expect(db.prepare(`SELECT kind FROM app_messages WHERE title = ?`).all(INGEST_UNREACHABLE_TITLE)).toEqual([]);
    expect(jobById(a.job_id!)).toMatchObject({ status: "queued", error: expect.stringMatching(/ECONNREFUSED/) });
    const runId = lastRunId(feeder);
    expect(ingestRunById(runId)).toMatchObject({ status: "not_started" });
    // Not offered again before the retry delay (the hour's poll, free to go meanwhile, is offered — and fails too).
    await step("2099-06-11T02:00:20Z", feeder, notified);
    const nightlyCalls = () => feeder.calls.filter((c) => c.kind === "nightly").map((c) => c.runId);
    expect(nightlyCalls()).toEqual([runId]);
    await step("2099-06-11T02:00:45Z", feeder, notified);
    expect(nightlyCalls()).toEqual([runId, runId]);
    expect(db.prepare(`SELECT kind FROM app_messages WHERE title = ?`).all(INGEST_UNREACHABLE_TITLE)).toEqual([{ kind: "notification" }]);

    feeder.answer = { status: "accepted" };
    await step("2099-06-11T02:01:20Z", feeder, notified);
    expect(nightlyCalls().at(-1)).toBe(runId);
    expect(ingestRunById(runId)).toMatchObject({ status: "requested", error: null });
    expect(jobById(a.job_id!)).toMatchObject({ status: "running" });
  });

  it("keeps an hourly the service is busy for queued until it can start (no longer given up)", async () => {
    db.prepare(`INSERT INTO ingest_runs (kind, slot_at, status, reason) VALUES ('nightly', ?, 'done', 'test')`).run(NIGHTLY.toISOString());
    const feeder = fakeFeeder({ status: "busy", detail: "running a outside run" });
    const hourly = await step("2099-06-11T02:30:05Z", feeder);
    expect(jobById(hourly.job_id!)).toMatchObject({ status: "queued" });
    feeder.answer = { status: "accepted" };
    await step("2099-06-11T02:40:00Z", feeder);
    expect(jobById(hourly.job_id!)).toMatchObject({ status: "running" });
    expect(feeder.calls).toHaveLength(2);
  });

  it("writes off a run whose service stopped heartbeating, as a failed run, and frees the queue", async () => {
    const feeder = fakeFeeder({ status: "accepted" });
    const first = await step("2099-06-11T02:00:10Z", feeder);
    const runId = lastRunId(feeder);
    heartbeatJob(first.job_id!, new Date("2099-06-11T02:01:00Z"));
    await step("2099-06-11T02:05:30Z", feeder);
    expect(jobById(first.job_id!)!.status).toBe("running");
    await step("2099-06-11T02:06:30Z", feeder);
    expect(jobById(first.job_id!)).toMatchObject({ status: "lost", error: expect.stringMatching(/no heartbeat from ingest-service for 5 min/) });
    expect(ingestRunById(runId)).toMatchObject({ status: "lost" });
    expect(runMessages()).toEqual([
      expect.objectContaining({ kind: "notification", title: "Daily bank run failed", body: expect.stringMatching(/no heartbeat/) }),
    ]);
    // The hour's poll, queued meanwhile, started once the nightly was written off.
    expect(feeder.calls.map((c) => c.kind)).toEqual(["nightly", "hourly"]);
    // A late report of the lost run is still recorded.
    completeIngestRun(runId, report());
    expect(jobById(first.job_id!)!.status).toBe("done");
  });

  it("supersedes a queued nightly a run started by hand already covered", async () => {
    const feeder = fakeFeeder({ status: "busy", detail: "running a outside run" });
    const queued = await step("2099-06-11T02:00:10Z", feeder);
    expect(jobById(queued.job_id!)).toMatchObject({ status: "queued" });
    // A daily run (by hand, outside the queue) is recorded after the slot.
    db.prepare(`INSERT INTO app_messages (kind, title, body, created_at) VALUES ('log', 'Daily bank run', 'x', '2099-06-11 02:10:00')`).run();
    feeder.answer = { status: "accepted" };
    await step("2099-06-11T02:11:00Z", feeder);
    expect(jobById(queued.job_id!)).toMatchObject({ status: "superseded", error: expect.stringMatching(/after the slot/) });
    expect(listRecentIngestRuns().find((r) => r.kind === "nightly")).toMatchObject({ status: "skipped", job_id: queued.job_id });
    expect(feeder.calls.filter((c) => c.kind === "nightly")).toHaveLength(1);
  });

  it("asks an hourly poll for a catch-up when the nightly fetch failed, once per slot", async () => {
    const ok = fakeFeeder({ status: "accepted" });
    await step("2099-06-11T02:00:10Z", ok);
    // The nightly's fetch failed; its report carries the bank facts (last success yesterday).
    completeIngestRun(
      lastRunId(ok),
      report({
        exit_code: 1,
        steps: [{ label: "fetch Santander", ok: false, seconds: 98 }],
        santander: { mode: "nightly", outcome: "failed", note: null },
        santander_state: { ...STATE, last_attempt_at: "2099-06-11T02:00:15.000Z", last_success_at: "2099-06-10T02:01:00.000Z" },
      })
    );
    // The hour's poll queued at 02:00:40 waited; it starts at 02:40 with the catch-up decided then.
    await step("2099-06-11T02:00:40Z", ok);
    expect(ok.calls.at(-1)?.kind).toBe("hourly");
    expect(ok.calls.at(-1)?.santanderFetch).toBeNull(); // the bank was tried 25 s ago
    completeIngestRun(lastRunId(ok), report({ santander: null, santander_state: { ...STATE, last_attempt_at: "2099-06-11T02:00:15.000Z", last_success_at: "2099-06-10T02:01:00.000Z" } }));
    await step("2099-06-11T02:40:00Z", ok);
    expect(ok.calls.at(-1)).toMatchObject({ kind: "hourly", santanderFetch: { mode: "catch-up" } });
    const hourly = lastRunId(ok);
    expect(ingestRunById(hourly)).toMatchObject({ santander_request: "catch-up" });
    completeIngestRun(
      hourly,
      report({
        exit_code: 1,
        steps: [{ label: "fetch Santander (catch-up)", ok: false, seconds: 60 }],
        activity: true,
        santander: { mode: "catch-up", outcome: "failed", note: null },
        santander_state: { ...STATE, last_attempt_at: "2099-06-11T02:40:05.000Z", last_success_at: "2099-06-10T02:01:00.000Z" },
      })
    );
    // The slot's one retry is used: the next hour polls mail only.
    await step("2099-06-11T03:30:05Z", ok);
    expect(ok.calls.at(-1)).toMatchObject({ kind: "hourly", santanderFetch: null });
  });
});

describe("startManualIngestRun", () => {
  const ON = { INGEST_SCHEDULER_ENABLED: "1" } as NodeJS.ProcessEnv;
  const AT = new Date("2099-06-10T18:40:00Z");

  beforeEach(() => {
    messageIdFloor = (db.prepare(`SELECT COALESCE(MAX(id), 0) AS m FROM app_messages`).get() as { m: number }).m;
    clear();
  });
  afterEach(clear);

  it("refuses on an instance whose scheduler is off, queuing nothing", () => {
    expect(startManualIngestRun("hourly", AT, {})).toMatchObject({ status: "refused", reason: "scheduler_off" });
    expect(listJobsByStatus("queued")).toEqual([]);
  });

  it("queues a run that starts now and answers its hour's slot", async () => {
    db.prepare(`INSERT INTO ingest_runs (kind, slot_at, status, reason) VALUES ('nightly', ?, 'done', 'test')`).run("2099-06-10T02:00:00.000Z");
    db.prepare(`INSERT INTO ingest_runs (kind, slot_at, status, reason) VALUES ('hourly', ?, 'done', 'test')`).run("2099-06-10T17:30:00.000Z");
    const feeder = fakeFeeder({ status: "accepted" });
    const out = startManualIngestRun("hourly", AT, ON);
    expect(out).toMatchObject({ status: "queued", coalesced: false });
    await jobQueueTick(AT, { request: feeder.request, notified: new Set() });
    expect(feeder.calls).toEqual([{ runId: expect.any(Number), jobId: (out as { job_id: number }).job_id, kind: "hourly", reason: MANUAL_RUN_REASON, santanderFetch: null }]);
    const runId = lastRunId(feeder);
    expect(ingestRunById(runId)).toMatchObject({ kind: "hourly", status: "requested", slot_at: AT.toISOString() });

    // A second click while it runs queues behind it; the 18:30 slot it ran in is answered.
    expect(startManualIngestRun("nightly", AT, ON)).toMatchObject({ status: "queued" });
    expect(ingestSchedulerTick(new Date("2099-06-10T18:41:00Z")).decision).toEqual({ action: "idle" });
    completeIngestRun(runId, report({ santander: null, santander_state: STATE }));
    await jobQueueTick(new Date("2099-06-10T18:45:00Z"), { request: feeder.request, notified: new Set() });
    expect(feeder.calls.at(-1)).toMatchObject({ kind: "nightly", reason: MANUAL_RUN_REASON });
  });

  it("moves up a run of the same kind already queued instead of adding one", () => {
    const scheduled = ingestSchedulerTick(new Date("2099-06-10T18:30:05Z"));
    const out = startManualIngestRun(scheduled.decision.action === "request" ? scheduled.decision.kind : "hourly", AT, ON);
    expect(out).toMatchObject({ status: "queued", coalesced: true, job_id: scheduled.job_id });
    expect(jobById(scheduled.job_id!)).toMatchObject({ enqueued_by: "manual", reason: MANUAL_RUN_REASON, stale_after: null });
  });
});

describe("run reports", () => {
  let server: Server | null = null;
  beforeEach(() => {
    messageIdFloor = (db.prepare(`SELECT COALESCE(MAX(id), 0) AS m FROM app_messages`).get() as { m: number }).m;
    clear();
  });
  afterEach(async () => {
    clear();
    const s = server;
    server = null;
    if (s) await new Promise<void>((r) => s.close(() => r()));
  });

  async function start(): Promise<string> {
    const app = express();
    app.use(express.json());
    registerIngestRoutes(app, { auth: { token: null, allowRemote: false, demoMode: false } });
    registerJobRoutes(app, { auth: { token: null, allowRemote: false, demoMode: false } });
    const s = await new Promise<Server>((resolve) => {
      const started: Server = app.listen(0, "127.0.0.1", () => resolve(started));
    });
    server = s;
    return `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
  }

  it("records a finished run and its job, and refuses a second report", async () => {
    const feeder = fakeFeeder({ status: "accepted" });
    const { job_id } = await step("2099-06-11T02:00:10Z", feeder);
    const run_id = lastRunId(feeder);
    const base = await start();
    const client = createIngestClient({ baseUrl: base, feederId: "vitest" });
    const failed = report({
      exit_code: 1,
      steps: [
        { label: "fetch Santander", ok: true, seconds: 400 },
        { label: "inbox pipeline", ok: false, seconds: 12 },
      ],
    });
    await client.completeRun(run_id, failed);
    expect(ingestRunById(run_id)).toMatchObject({ status: "failed", exit_code: 1, failed_steps: 1, santander_outcome: "ok" });
    expect(jobById(job_id!)).toMatchObject({ status: "failed", error: "exit 1, 1 failed step(s)" });
    expect(runMessages()).toEqual([
      expect.objectContaining({ kind: "notification", title: "Daily bank run failed", body: expect.stringMatching(/inbox pipeline/) }),
    ]);
    await expect(client.completeRun(run_id, failed)).rejects.toThrow(/run_not_waiting/);
    await expect(client.completeRun(999_999, failed)).rejects.toThrow(/unknown_ingest_run/);
    expect(listRecentIngestRuns(1)[0]?.id).toBe(run_id);
  });

  it("heartbeats a running job, and refuses one that is not running", async () => {
    const feeder = fakeFeeder({ status: "accepted" });
    const { job_id } = await step("2099-06-11T02:00:10Z", feeder);
    const client = createIngestClient({ baseUrl: await start(), feederId: "vitest" });
    await client.heartbeatJob(job_id!);
    expect(jobById(job_id!)!.heartbeat_at! > "2099").toBe(false); // stamped with the real clock
    completeIngestRun(lastRunId(feeder), report());
    await expect(client.heartbeatJob(job_id!)).rejects.toThrow(/job_not_running/);
    await expect(client.heartbeatJob(999_999)).rejects.toThrow(/unknown_job/);
  });

  it("takes the report of a run marked not started: the service had taken it after all", async () => {
    const down = fakeFeeder({ status: "unreachable", detail: "The operation was aborted due to timeout" });
    const { job_id } = await step("2099-06-11T02:00:10Z", down);
    const run_id = lastRunId(down);
    expect(ingestRunById(run_id)).toMatchObject({ status: "not_started" });
    const client = createIngestClient({ baseUrl: await start(), feederId: "vitest" });
    await client.completeRun(run_id, report());
    expect(ingestRunById(run_id)).toMatchObject({ status: "done" });
    expect(jobById(job_id!)).toMatchObject({ status: "done" });
  });

  it("marks a clean run done", async () => {
    const feeder = fakeFeeder({ status: "accepted" });
    await step("2099-06-11T02:00:10Z", feeder);
    const client = createIngestClient({ baseUrl: await start(), feederId: "vitest" });
    await client.completeRun(lastRunId(feeder), report());
    expect(ingestRunById(lastRunId(feeder))).toMatchObject({ status: "done", failed_steps: 0 });
    expect(runMessages().map((m) => m.title)).toEqual(["Daily bank run"]);
  });

  it("records nothing for a dry run or a quiet hourly poll", async () => {
    const feeder = fakeFeeder({ status: "accepted" });
    await step("2099-06-11T02:00:10Z", feeder);
    completeIngestRun(lastRunId(feeder), report({ dry_run: true }));
    await step("2099-06-11T02:30:05Z", feeder);
    const hourly = lastRunId(feeder);
    completeIngestRun(hourly, report({ santander: null, activity: false }));
    expect(runMessages()).toEqual([]);
    expect(ingestRunById(hourly)).toMatchObject({ status: "done", activity: 0 });
  });
});

describe("requestFeederRun", () => {
  async function stubService(status: number, body: unknown): Promise<{ env: NodeJS.ProcessEnv; close: () => Promise<void> }> {
    const app = express();
    app.post("/runs", (_req, res) => void res.status(status).json(body));
    const s = await new Promise<Server>((resolve) => {
      const started: Server = app.listen(0, "127.0.0.1", () => resolve(started));
    });
    return {
      env: { INGEST_URL: `http://127.0.0.1:${(s.address() as AddressInfo).port}` },
      close: () => new Promise<void>((r) => s.close(() => r())),
    };
  }

  it("reads the service running or having run this same run as accepted", async () => {
    const cases: [number, unknown, FeederAnswer["status"]][] = [
      [409, { error: "busy", running: { run_id: 50, kind: "nightly", started_at: "2099-06-11T02:33:04.679Z" } }, "accepted"],
      [409, { error: "already_ran", run_id: 50 }, "accepted"],
      [409, { error: "busy", running: { run_id: 49, kind: "hourly", started_at: "2099-06-11T02:30:00.000Z" } }, "busy"],
    ];
    for (const [status, body, expected] of cases) {
      const svc = await stubService(status, body);
      try {
        const request = { run_id: 50, job_id: 7, kind: "nightly" as const, reason: "x", santander_fetch: null, afp_uno_fetch: null, afc_fetch: null, payslips: null, mortgage_sheet: null };
        expect((await requestFeederRun(request, svc.env)).status).toBe(expected);
      } finally {
        await svc.close();
      }
    }
  });
});

describe("ingestSchedulerEnabled", () => {
  it("needs the flag and is never on with background jobs off", () => {
    expect(ingestSchedulerEnabled({})).toBe(false);
    expect(ingestSchedulerEnabled({ INGEST_SCHEDULER_ENABLED: "1" })).toBe(true);
    expect(ingestSchedulerEnabled({ INGEST_SCHEDULER_ENABLED: "1", BACKGROUND_JOBS_ENABLED: "0" })).toBe(false);
  });
});
