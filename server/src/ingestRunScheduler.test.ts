import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import express from "express";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createIngestClient, type IngestRunKind } from "nw-tracker-contracts";
import { db } from "./db.js";
import { INGEST_UNREACHABLE_TITLE, ingestSchedulerEnabled, ingestSchedulerTick, type FeederAnswer } from "./ingestRunScheduler.js";
import { ingestRunById, listRecentIngestRuns } from "./ingestRuns.js";
import { registerIngestRoutes } from "./routes/ingest.js";

/**
 * Far-future clock: every daily run the test DB already holds is long before these slots, so
 * only the rows written here decide. 2099-06-10 is winter in Chile (UTC−4): 22:00 = 02:00Z.
 */
const NIGHTLY = new Date("2099-06-11T02:00:00Z");

type Call = { runId: number; kind: IngestRunKind; reason: string };

function fakeFeeder(answer: FeederAnswer) {
  const calls: Call[] = [];
  const request = async (runId: number, kind: IngestRunKind, reason: string) => {
    calls.push({ runId, kind, reason });
    return answer;
  };
  return { calls, request };
}

function clear() {
  db.prepare(`DELETE FROM ingest_runs`).run();
  db.prepare(`DELETE FROM app_messages WHERE title = ?`).run(INGEST_UNREACHABLE_TITLE);
}

describe("ingestSchedulerTick", () => {
  beforeEach(clear);
  afterEach(clear);

  it("asks for the nightly, then the hourly slot is skipped while it runs, and nothing twice", async () => {
    const feeder = fakeFeeder({ status: "accepted" });
    const notified = new Set<string>();
    const first = await ingestSchedulerTick(new Date("2099-06-11T02:00:10Z"), notified, feeder.request);
    expect(first.decision).toMatchObject({ action: "request", kind: "nightly", slot: NIGHTLY });
    expect(feeder.calls).toEqual([{ runId: first.run_id, kind: "nightly", reason: "22:00 slot, on time" }]);
    expect(ingestRunById(first.run_id!)).toMatchObject({ status: "requested", slot_at: NIGHTLY.toISOString() });

    // Same minute: the hour's :30 slot (01:30Z) is next, skipped behind the nightly in flight.
    const second = await ingestSchedulerTick(new Date("2099-06-11T02:00:40Z"), notified, feeder.request);
    expect(second.decision).toMatchObject({ action: "skip", kind: "hourly" });
    expect((await ingestSchedulerTick(new Date("2099-06-11T02:01:10Z"), notified, feeder.request)).decision).toEqual({
      action: "idle",
    });
    expect(feeder.calls).toHaveLength(1);
  });

  it("retries a nightly the service did not take, badging an outage once per slot", async () => {
    const down = fakeFeeder({ status: "unreachable", detail: "fetch failed — connect ECONNREFUSED" });
    const notified = new Set<string>();
    const a = await ingestSchedulerTick(new Date("2099-06-11T02:00:10Z"), notified, down.request);
    const b = await ingestSchedulerTick(new Date("2099-06-11T02:00:40Z"), notified, down.request);
    expect([a.run_id, b.run_id]).toEqual([a.run_id, a.run_id]); // the same slot row, retried
    expect(ingestRunById(a.run_id!)).toMatchObject({ status: "not_started", error: expect.stringMatching(/ECONNREFUSED/) });
    const badges = db.prepare(`SELECT kind FROM app_messages WHERE title = ?`).all(INGEST_UNREACHABLE_TITLE);
    expect(badges).toEqual([{ kind: "notification" }]);

    const up = fakeFeeder({ status: "accepted" });
    const c = await ingestSchedulerTick(new Date("2099-06-11T02:01:10Z"), notified, up.request);
    expect(c.run_id).toBe(a.run_id);
    expect(ingestRunById(a.run_id!)).toMatchObject({ status: "requested", error: null });
  });

  it("gives up an hourly slot the service did not take", async () => {
    // The nightly for this day already answered, so the hourly is what is due.
    const ok = fakeFeeder({ status: "accepted" });
    const notified = new Set<string>();
    const nightly = await ingestSchedulerTick(new Date("2099-06-11T02:00:10Z"), notified, ok.request);
    db.prepare(`UPDATE ingest_runs SET status = 'done' WHERE id = ?`).run(nightly.run_id);
    const busy = fakeFeeder({ status: "busy", detail: "running a nightly run" });
    const hourly = await ingestSchedulerTick(new Date("2099-06-11T02:30:05Z"), notified, busy.request);
    expect(hourly.decision).toMatchObject({ action: "request", kind: "hourly" });
    expect(ingestRunById(hourly.run_id!)).toMatchObject({ status: "not_started" });
    expect((await ingestSchedulerTick(new Date("2099-06-11T02:30:40Z"), notified, busy.request)).decision).toEqual({
      action: "idle",
    });
  });

  it("writes off a run that never reported", async () => {
    const feeder = fakeFeeder({ status: "accepted" });
    const first = await ingestSchedulerTick(new Date("2099-06-11T02:00:10Z"), new Set(), feeder.request);
    await ingestSchedulerTick(new Date("2099-06-11T05:10:00Z"), new Set(), feeder.request);
    expect(ingestRunById(first.run_id!)).toMatchObject({ status: "lost" });
  });
});

describe("run reports", () => {
  let server: Server | null = null;
  beforeEach(clear);
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
    const s = await new Promise<Server>((resolve) => {
      const started: Server = app.listen(0, "127.0.0.1", () => resolve(started));
    });
    server = s;
    return `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
  }

  it("records a finished run, and refuses a second report", async () => {
    const feeder = fakeFeeder({ status: "accepted" });
    const { run_id } = await ingestSchedulerTick(new Date("2099-06-11T02:00:10Z"), new Set(), feeder.request);
    const base = await start();
    const client = createIngestClient({ baseUrl: base, feederId: "vitest" });
    const report = {
      started_at: "2099-06-11T02:00:11.000Z",
      finished_at: "2099-06-11T02:12:00.000Z",
      exit_code: 1,
      steps: [
        { label: "fetch Santander", ok: true, seconds: 400 },
        { label: "inbox pipeline", ok: false, seconds: 12 },
      ],
    };
    await client.completeRun(run_id!, report);
    expect(ingestRunById(run_id!)).toMatchObject({ status: "failed", exit_code: 1, failed_steps: 1 });
    await expect(client.completeRun(run_id!, report)).rejects.toThrow(/run_not_waiting/);
    await expect(client.completeRun(999_999, report)).rejects.toThrow(/unknown_ingest_run/);
    expect(listRecentIngestRuns(1)[0]?.id).toBe(run_id);
  });

  it("marks a clean run done", async () => {
    const feeder = fakeFeeder({ status: "accepted" });
    const { run_id } = await ingestSchedulerTick(new Date("2099-06-11T02:00:10Z"), new Set(), feeder.request);
    const client = createIngestClient({ baseUrl: await start(), feederId: "vitest" });
    await client.completeRun(run_id!, {
      started_at: "2099-06-11T02:00:11.000Z",
      finished_at: "2099-06-11T02:12:00.000Z",
      exit_code: 0,
      steps: [{ label: "fetch Santander", ok: true, seconds: 400 }],
    });
    expect(ingestRunById(run_id!)).toMatchObject({ status: "done", failed_steps: 0 });
  });
});

describe("ingestSchedulerEnabled", () => {
  it("needs the flag and is never on with background jobs off", () => {
    expect(ingestSchedulerEnabled({})).toBe(false);
    expect(ingestSchedulerEnabled({ INGEST_SCHEDULER_ENABLED: "1" })).toBe(true);
    expect(ingestSchedulerEnabled({ INGEST_SCHEDULER_ENABLED: "1", BACKGROUND_JOBS_ENABLED: "0" })).toBe(false);
  });
});
