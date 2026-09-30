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
import { INGEST_UNREACHABLE_TITLE, ingestSchedulerEnabled, ingestSchedulerTick, type FeederAnswer } from "./ingestRunScheduler.js";
import { completeIngestRun, ingestRunById, listRecentIngestRuns } from "./ingestRuns.js";
import { registerIngestRoutes } from "./routes/ingest.js";

/**
 * Far-future clock: every daily run the test DB already holds is long before these slots, so
 * only the rows written here decide. 2099-06-10 is winter in Chile (UTC−4): 22:00 = 02:00Z.
 */
const NIGHTLY = new Date("2099-06-11T02:00:00Z");

type Call = { runId: number; kind: IngestRunKind; reason: string; santanderFetch: IngestRunRequest["santander_fetch"] };

function fakeFeeder(answer: FeederAnswer) {
  const calls: Call[] = [];
  const request = async (runId: number, kind: IngestRunKind, reason: string, santanderFetch: IngestRunRequest["santander_fetch"]) => {
    calls.push({ runId, kind, reason, santanderFetch });
    return answer;
  };
  return { calls, request };
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
  db.prepare(`DELETE FROM ingest_runs`).run();
  db.prepare(`DELETE FROM app_messages WHERE title = ? OR id > ?`).run(INGEST_UNREACHABLE_TITLE, messageIdFloor);
}

function runMessages(): { kind: string; title: string; body: string }[] {
  return db
    .prepare(`SELECT kind, title, body FROM app_messages WHERE id > ? ORDER BY id`)
    .all(messageIdFloor) as { kind: string; title: string; body: string }[];
}

describe("ingestSchedulerTick", () => {
  beforeEach(() => {
    messageIdFloor = (db.prepare(`SELECT COALESCE(MAX(id), 0) AS m FROM app_messages`).get() as { m: number }).m;
    clear();
  });
  afterEach(clear);

  it("asks for the nightly, then the hourly slot is skipped while it runs, and nothing twice", async () => {
    const feeder = fakeFeeder({ status: "accepted" });
    const notified = new Set<string>();
    const first = await ingestSchedulerTick(new Date("2099-06-11T02:00:10Z"), notified, feeder.request);
    expect(first.decision).toMatchObject({ action: "request", kind: "nightly", slot: NIGHTLY });
    expect(feeder.calls).toEqual([
      { runId: first.run_id, kind: "nightly", reason: "22:00 slot, on time", santanderFetch: null },
    ]);
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

  it("writes off a run that never reported, as a failed run", async () => {
    const feeder = fakeFeeder({ status: "accepted" });
    const first = await ingestSchedulerTick(new Date("2099-06-11T02:00:10Z"), new Set(), feeder.request);
    await ingestSchedulerTick(new Date("2099-06-11T05:10:00Z"), new Set(), feeder.request);
    expect(ingestRunById(first.run_id!)).toMatchObject({ status: "lost" });
    expect(runMessages()).toEqual([
      expect.objectContaining({ kind: "notification", title: "Daily bank run failed", body: expect.stringMatching(/no report within 180 min/) }),
    ]);
  });

  it("asks an hourly poll for a catch-up when the nightly fetch failed, once per slot", async () => {
    const ok = fakeFeeder({ status: "accepted" });
    const nightly = await ingestSchedulerTick(new Date("2099-06-11T02:00:10Z"), new Set(), ok.request);
    // The nightly's fetch failed; its report carries the bank facts (last success yesterday).
    completeIngestRun(
      nightly.run_id!,
      report({
        exit_code: 1,
        steps: [{ label: "fetch Santander", ok: false, seconds: 98 }],
        santander: { mode: "nightly", outcome: "failed", note: null },
        santander_state: { ...STATE, last_attempt_at: "2099-06-11T02:00:15.000Z", last_success_at: "2099-06-10T02:01:00.000Z" },
      })
    );
    const hourly = await ingestSchedulerTick(new Date("2099-06-11T02:40:00Z"), new Set(), ok.request);
    expect(hourly.decision).toMatchObject({ action: "request", kind: "hourly" });
    expect(ok.calls.at(-1)?.santanderFetch).toMatchObject({ mode: "catch-up" });
    expect(ingestRunById(hourly.run_id!)).toMatchObject({ santander_request: "catch-up" });
    completeIngestRun(
      hourly.run_id!,
      report({
        exit_code: 1,
        steps: [{ label: "fetch Santander (catch-up)", ok: false, seconds: 60 }],
        activity: true,
        santander: { mode: "catch-up", outcome: "failed", note: null },
        santander_state: { ...STATE, last_attempt_at: "2099-06-11T02:40:05.000Z", last_success_at: "2099-06-10T02:01:00.000Z" },
      })
    );
    // The slot's one retry is used: the next hour polls mail only.
    await ingestSchedulerTick(new Date("2099-06-11T03:30:05Z"), new Set(), ok.request);
    expect(ok.calls.at(-1)).toMatchObject({ kind: "hourly", santanderFetch: null });
  });

  it("asks again after a declined catch-up", async () => {
    const ok = fakeFeeder({ status: "accepted" });
    const nightly = await ingestSchedulerTick(new Date("2099-06-11T02:00:10Z"), new Set(), ok.request);
    completeIngestRun(
      nightly.run_id!,
      report({ santander: { mode: "nightly", outcome: "failed", note: null }, santander_state: { ...STATE, last_attempt_at: "2099-06-11T02:00:15.000Z" } })
    );
    const hourly = await ingestSchedulerTick(new Date("2099-06-11T02:40:00Z"), new Set(), ok.request);
    completeIngestRun(
      hourly.run_id!,
      report({ santander: { mode: "catch-up", outcome: "vetoed", note: "last attempt 20 min ago" }, santander_state: { ...STATE, last_attempt_at: "2099-06-11T02:20:00.000Z" } })
    );
    await ingestSchedulerTick(new Date("2099-06-11T03:30:05Z"), new Set(), ok.request);
    expect(ok.calls.at(-1)).toMatchObject({ kind: "hourly", santanderFetch: { mode: "catch-up" } });
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
    const failed = report({
      exit_code: 1,
      steps: [
        { label: "fetch Santander", ok: true, seconds: 400 },
        { label: "inbox pipeline", ok: false, seconds: 12 },
      ],
    });
    await client.completeRun(run_id!, failed);
    expect(ingestRunById(run_id!)).toMatchObject({ status: "failed", exit_code: 1, failed_steps: 1, santander_outcome: "ok" });
    expect(runMessages()).toEqual([
      expect.objectContaining({ kind: "notification", title: "Daily bank run failed", body: expect.stringMatching(/inbox pipeline/) }),
    ]);
    await expect(client.completeRun(run_id!, failed)).rejects.toThrow(/run_not_waiting/);
    await expect(client.completeRun(999_999, failed)).rejects.toThrow(/unknown_ingest_run/);
    expect(listRecentIngestRuns(1)[0]?.id).toBe(run_id);
  });

  it("marks a clean run done", async () => {
    const feeder = fakeFeeder({ status: "accepted" });
    const { run_id } = await ingestSchedulerTick(new Date("2099-06-11T02:00:10Z"), new Set(), feeder.request);
    const client = createIngestClient({ baseUrl: await start(), feederId: "vitest" });
    await client.completeRun(run_id!, report());
    expect(ingestRunById(run_id!)).toMatchObject({ status: "done", failed_steps: 0 });
    expect(runMessages().map((m) => m.title)).toEqual(["Daily bank run"]);
  });

  it("records nothing for a dry run or a quiet hourly poll", async () => {
    const feeder = fakeFeeder({ status: "accepted" });
    const nightly = await ingestSchedulerTick(new Date("2099-06-11T02:00:10Z"), new Set(), feeder.request);
    completeIngestRun(nightly.run_id!, report({ dry_run: true }));
    const hourly = await ingestSchedulerTick(new Date("2099-06-11T02:30:05Z"), new Set(), feeder.request);
    completeIngestRun(hourly.run_id!, report({ santander: null, activity: false }));
    expect(runMessages()).toEqual([]);
    expect(ingestRunById(hourly.run_id!)).toMatchObject({ status: "done", activity: 0 });
  });
});

describe("ingestSchedulerEnabled", () => {
  it("needs the flag and is never on with background jobs off", () => {
    expect(ingestSchedulerEnabled({})).toBe(false);
    expect(ingestSchedulerEnabled({ INGEST_SCHEDULER_ENABLED: "1" })).toBe(true);
    expect(ingestSchedulerEnabled({ INGEST_SCHEDULER_ENABLED: "1", BACKGROUND_JOBS_ENABLED: "0" })).toBe(false);
  });
});
