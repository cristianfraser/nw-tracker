import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import express from "express";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { IngestRunRequest } from "nw-tracker-contracts";
import { db } from "./db.js";
import type { FeederAnswer } from "./ingestRunScheduler.js";
import { enqueueIngestRun, SCHEDULER_ENQUEUED_BY } from "./ingestRunScheduler.js";
import { completeIngestRun } from "./ingestRuns.js";
import { DEPLOY_STALE_AFTER_MS, claimNextJob, completeClaimedJob, enqueueDeploy } from "./jobClaims.js";
import { heartbeatJob, jobById, jobPayload } from "./jobQueue.js";
import { jobQueueTick } from "./jobQueueExecutor.js";
import { registerJobRoutes } from "./routes/jobs.js";
import { clearJobs } from "./test/jobQueueTestUtils.js";

const T0 = new Date("2099-06-11T05:00:00.000Z");
const at = (minutes: number) => new Date(T0.getTime() + minutes * 60_000);
const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);

let messageIdFloor = 0;
function clear() {
  clearJobs();
  db.prepare(`DELETE FROM ingest_runs`).run();
  db.prepare(`DELETE FROM app_messages WHERE id > ?`).run(messageIdFloor);
}

function feeder() {
  const calls: IngestRunRequest[] = [];
  return { calls, request: async (r: IngestRunRequest): Promise<FeederAnswer> => (calls.push(r), { status: "accepted" }) };
}

const REPORT = {
  started_at: "2099-06-11T05:00:01.000Z",
  finished_at: "2099-06-11T05:02:00.000Z",
  exit_code: 0,
  steps: [{ label: "mail", ok: true, seconds: 60 }],
  dry_run: true,
  activity: false,
  santander: null,
  santander_state: { last_attempt_at: null, last_success_at: null, login_latched: false, last_catch_up_attempt_at: null, last_payday_attempt_ymd: null },
};

beforeEach(() => {
  messageIdFloor = (db.prepare(`SELECT COALESCE(MAX(id), 0) AS m FROM app_messages`).get() as { m: number }).m;
  clear();
});
afterEach(clear);

describe("deploys through the queue", () => {
  it("grants a deploy when nothing runs, and starts nothing else while it holds server-restart", async () => {
    const { job } = enqueueDeploy({ kind: "deploy", sha: SHA_A, reason: "deploy-agent: origin/main aaaaaaaa" }, T0);
    const claim = claimNextJob("deploy", "deploy-agent", at(0));
    expect(claim.job).toMatchObject({ id: job.id, status: "running", worker: "deploy-agent" });
    expect(jobPayload(claim.job!)).toEqual({ sha: SHA_A });

    // An hourly slot comes due during the deploy; the executor (also the one that boots after
    // the restart: a fresh context) keeps it waiting.
    enqueueIngestRun("hourly", at(1), ":30 slot", SCHEDULER_ENQUEUED_BY, at(1));
    const f = feeder();
    const d = await jobQueueTick(at(2), { request: f.request, notified: new Set() });
    expect(f.calls).toEqual([]);
    expect(d.waiting.map((w) => w.reason.code)).toEqual(["exclusive"]);

    completeClaimedJob(job.id, { ok: true, result: { from: "x", to: SHA_A }, error: null }, at(5));
    expect(jobById(job.id)).toMatchObject({ status: "done", result_json: JSON.stringify({ from: "x", to: SHA_A }) });
    await jobQueueTick(at(5), { request: f.request, notified: new Set() });
    expect(f.calls.map((c) => c.kind)).toEqual(["hourly"]);
  });

  it("waits for a running ingest run, draining the queue meanwhile, then grants it", async () => {
    const f = feeder();
    enqueueIngestRun("nightly", at(0), "22:00 slot", SCHEDULER_ENQUEUED_BY, at(0));
    await jobQueueTick(at(0), { request: f.request, notified: new Set() });
    const nightlyRun = f.calls[0]!;
    enqueueDeploy({ kind: "deploy", sha: SHA_A, reason: "push" }, at(1));
    expect(claimNextJob("deploy", "deploy-agent", at(1))).toEqual({
      job: null,
      waiting: `waiting for server-restart, held by ingest.nightly job ${nightlyRun.job_id}`,
    });
    // An hourly due meanwhile does not start after the nightly: the deploy goes first.
    enqueueIngestRun("hourly", at(2), ":30 slot", SCHEDULER_ENQUEUED_BY, at(2));
    heartbeatJob(nightlyRun.job_id!, at(3));
    completeIngestRun(nightlyRun.run_id, REPORT);
    await jobQueueTick(at(4), { request: f.request, notified: new Set() });
    expect(f.calls).toHaveLength(1);
    expect(claimNextJob("deploy", "deploy-agent", at(4)).job).toMatchObject({ status: "running" });
  });

  it("moves a waiting deploy to the newest pushed commit", () => {
    const f = enqueueDeploy({ kind: "deploy", sha: SHA_A, reason: "a" }, T0);
    const s = enqueueDeploy({ kind: "deploy", sha: SHA_B, reason: "b" }, at(3));
    expect(s).toMatchObject({ coalesced: true, job: { id: f.job.id } });
    expect(jobPayload(s.job)).toEqual({ sha: SHA_B });
    expect(s.job.stale_after).toBe(new Date(at(3).getTime() + DEPLOY_STALE_AFTER_MS).toISOString());
  });

  it("lets a deploy the agent stopped asking for go stale, so the queue does not stay drained", async () => {
    enqueueDeploy({ kind: "deploy", sha: SHA_A, reason: "a" }, T0);
    enqueueIngestRun("hourly", at(1), ":30 slot", SCHEDULER_ENQUEUED_BY, at(1));
    const f = feeder();
    // A running nightly makes the deploy wait; meanwhile the hourly is drained.
    db.prepare(
      `INSERT INTO jobs (kind, status, priority, resources_json, worker, claimed_at, heartbeat_at, lease_ms, enqueued_by, reason, created_at)
       VALUES ('ingest.nightly', 'running', 50, '["ingest-service"]', 'ingest-service', ?, ?, 300000, 'test', 'test', ?)`
    ).run(at(0).toISOString(), at(14).toISOString(), at(0).toISOString());
    const running = (db.prepare(`SELECT id FROM jobs WHERE kind = 'ingest.nightly'`).get() as { id: number }).id;
    await jobQueueTick(at(14), { request: f.request, notified: new Set() });
    expect(f.calls).toEqual([]);
    db.prepare(`UPDATE jobs SET status = 'done' WHERE id = ?`).run(running);
    const d = await jobQueueTick(at(16), { request: f.request, notified: new Set() });
    expect(d.superseded.map((j) => j.kind)).toEqual(["deploy"]);
    expect(f.calls.map((c) => c.kind)).toEqual(["hourly"]);
  });

  it("writes off a deploy whose agent went silent, badging it, and resumes the queue", async () => {
    const { job } = enqueueDeploy({ kind: "deploy", sha: SHA_A, reason: "a" }, T0);
    claimNextJob("deploy", "deploy-agent", T0);
    heartbeatJob(job.id, at(2));
    enqueueIngestRun("hourly", at(3), ":30 slot", SCHEDULER_ENQUEUED_BY, at(3));
    const f = feeder();
    await jobQueueTick(at(21), { request: f.request, notified: new Set() });
    expect(f.calls).toEqual([]);
    await jobQueueTick(at(22), { request: f.request, notified: new Set() });
    expect(jobById(job.id)).toMatchObject({ status: "lost" });
    expect(f.calls.map((c) => c.kind)).toEqual(["hourly"]);
    const badge = db.prepare(`SELECT kind, title FROM app_messages WHERE id > ? AND title LIKE 'Job lost%'`).all(messageIdFloor);
    expect(badge).toEqual([{ kind: "notification", title: "Job lost: deploy" }]);
    // The agent's late report is still taken.
    expect(completeClaimedJob(job.id, { ok: false, result: null, error: "rolled back" }, at(23)).status).toBe("failed");
  });

  it("says why nothing was claimed when no deploy is queued", () => {
    expect(claimNextJob("deploy", "deploy-agent", T0)).toEqual({ job: null, waiting: "no deploy job is queued" });
  });
});

describe("/api/jobs", () => {
  let server: Server | null = null;
  afterEach(async () => {
    const s = server;
    server = null;
    if (s) await new Promise<void>((r) => s.close(() => r()));
  });

  async function start(): Promise<(path: string, body: unknown) => Promise<{ status: number; body: Record<string, unknown> }>> {
    const app = express();
    app.use(express.json());
    registerJobRoutes(app, { auth: { token: null, allowRemote: false, demoMode: false } });
    const s = await new Promise<Server>((resolve) => {
      const started: Server = app.listen(0, "127.0.0.1", () => resolve(started));
    });
    server = s;
    const base = `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
    return async (path, body) => {
      const res = await fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      return { status: res.status, body: (await res.json()) as Record<string, unknown> };
    };
  }

  it("enqueues, claims, heartbeats and completes a deploy the way the agent does", async () => {
    const post = await start();
    const enq = await post("/api/jobs", { kind: "deploy", sha: SHA_A, reason: "deploy-agent: origin/main aaaaaaaa" });
    expect(enq.status).toBe(200);
    const id = (enq.body.job as { id: number }).id;
    const claim = await post("/api/jobs/claim", { kind: "deploy", worker: "deploy-agent" });
    expect(claim.body).toMatchObject({ job: { id, status: "running" }, waiting: null });
    expect((await post(`/api/jobs/${id}/heartbeat`, {})).status).toBe(200);
    const done = await post(`/api/jobs/${id}/complete`, { ok: true, result: { to: SHA_A } });
    expect(done.body).toMatchObject({ job: { id, status: "done" } });
    expect((await post(`/api/jobs/${id}/complete`, { ok: true })).status).toBe(409);
  });

  it("refuses a malformed request, an unknown job, and completing an ingest run here", async () => {
    const post = await start();
    expect((await post("/api/jobs", { kind: "deploy", sha: "main", reason: "x" })).status).toBe(400);
    expect((await post("/api/jobs", { kind: "ingest.nightly", sha: SHA_A, reason: "x" })).status).toBe(400);
    expect((await post("/api/jobs/999999/complete", { ok: true })).status).toBe(404);
    const { job } = enqueueIngestRun("hourly", T0, "x", SCHEDULER_ENQUEUED_BY, T0);
    db.prepare(`UPDATE jobs SET status = 'running', claimed_at = ?, heartbeat_at = ? WHERE id = ?`).run(T0.toISOString(), T0.toISOString(), job.id);
    const refused = await post(`/api/jobs/${job.id}/complete`, { ok: true });
    expect(refused.status).toBe(409);
    expect(refused.body.message).toMatch(/not completed by an outside worker/);
  });
});
