import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import type { IngestRunCompletion, IngestRunKind } from "nw-tracker-contracts";
import { createFeederServer, reportWithRetry, type FeederDeps } from "./feederServer.js";

const DONE: IngestRunCompletion = {
  started_at: "2026-09-30T01:00:00.000Z",
  finished_at: "2026-09-30T01:10:00.000Z",
  exit_code: 0,
  steps: [{ label: "fetch Santander", ok: true, seconds: 600 }],
  dry_run: false,
  activity: false,
  santander: { mode: "nightly", outcome: "ok", note: null },
  santander_state: {
    last_attempt_at: null,
    last_success_at: null,
    login_latched: false,
    last_catch_up_attempt_at: null,
    last_payday_attempt_ymd: null,
  },
};

let close: (() => Promise<void>) | null = null;
afterEach(async () => {
  await close?.();
  close = null;
});

/** A service whose run finishes when the test says so. */
async function start(over: Partial<FeederDeps> = {}) {
  const reports: { runId: number; completion: IngestRunCompletion }[] = [];
  let release: (c: IngestRunCompletion) => void = () => {};
  const runs: { kind: IngestRunKind; runId: number }[] = [];
  const feeder = createFeederServer({
    run: (request) => {
      runs.push({ kind: request.kind, runId: request.run_id });
      return new Promise((resolve) => (release = resolve));
    },
    report: async (runId, completion) => void reports.push({ runId, completion }),
    runningOutside: () => false,
    santanderState: () => DONE.santander_state,
    log: () => {},
    ...over,
  });
  await new Promise<void>((r) => feeder.server.listen(0, "127.0.0.1", () => r()));
  close = () => new Promise((r) => feeder.server.close(() => r()));
  const base = `http://127.0.0.1:${(feeder.server.address() as AddressInfo).port}`;
  const post = (body: unknown, headers: Record<string, string> = {}) =>
    fetch(`${base}/runs`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
  return { feeder, base, post, runs, reports, finish: (c: IngestRunCompletion) => release(c) };
}

describe("feeder server", () => {
  it("accepts a run at once, refuses a second while it runs, and reports the first when it ends", async () => {
    const s = await start();
    const first = await s.post({ run_id: 7, kind: "nightly", reason: "22:00 slot, on time", santander_fetch: null });
    expect(first.status).toBe(202);
    expect(s.runs).toEqual([{ kind: "nightly", runId: 7 }]);

    const second = await s.post({ run_id: 8, kind: "hourly", reason: ":30 slot", santander_fetch: null });
    expect(second.status).toBe(409);
    expect(await second.json()).toMatchObject({ error: "busy", running: { run_id: 7, kind: "nightly" } });
    expect(await (await fetch(`${s.base}/health`)).json()).toMatchObject({ ok: true, running: { run_id: 7 } });

    s.finish(DONE);
    await s.feeder.idle();
    expect(s.reports).toEqual([{ runId: 7, completion: DONE }]);
    expect((await s.post({ run_id: 8, kind: "hourly", reason: ":30 slot", santander_fetch: null })).status).toBe(202);
  });

  it("is busy while a runner it did not start is running", async () => {
    const s = await start({ runningOutside: () => true });
    const res = await s.post({ run_id: 7, kind: "nightly", reason: "x", santander_fetch: null });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ running: { run_id: null, kind: "outside" } });
    expect(s.runs).toEqual([]);
  });

  it("refuses a malformed request and a wrong token", async () => {
    const s = await start({ token: "abc" });
    expect((await s.post({ run_id: 7, kind: "weekly", reason: "x", santander_fetch: null }, { authorization: "Bearer abc" })).status).toBe(400);
    expect((await s.post({ run_id: 7, kind: "nightly", reason: "x", santander_fetch: null }, { authorization: "Bearer abd" })).status).toBe(401);
    expect((await s.post({ run_id: 7, kind: "nightly", reason: "x", santander_fetch: null }, { authorization: "Bearer abc" })).status).toBe(202);
  });

  it("reports a runner that could not start as a failure", async () => {
    const s = await start({
      run: async () => {
        throw new Error("spawn /bin/bash ENOENT");
      },
    });
    expect((await s.post({ run_id: 9, kind: "hourly", reason: "x", santander_fetch: null })).status).toBe(202);
    await s.feeder.idle();
    expect(s.reports[0]).toMatchObject({ runId: 9, completion: { exit_code: 127, steps: null } });
  });
});

describe("reportWithRetry", () => {
  it("retries while the server is down, then stops", async () => {
    let calls = 0;
    const logs: string[] = [];
    await reportWithRetry(
      async () => {
        calls++;
        if (calls < 3) throw new Error("ECONNREFUSED");
      },
      7,
      DONE,
      (m) => logs.push(m),
      [1, 1, 1]
    );
    expect(calls).toBe(3);
    calls = -100;
    await reportWithRetry(async () => void (calls++, (() => { throw new Error("down"); })()), 8, DONE, (m) => logs.push(m), [1]);
    expect(logs.at(-1)).toMatch(/giving up/);
  });
});
