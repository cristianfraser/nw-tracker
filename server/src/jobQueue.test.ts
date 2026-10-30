import { beforeEach, describe, expect, it } from "vitest";
import {
  cancelJob,
  claimJob,
  completeJob,
  enqueueJob,
  heartbeatJob,
  jobById,
  jobPayload,
  listJobsByStatus,
  markJobLost,
  releaseJob,
  supersedeJob,
} from "./jobQueue.js";
import { clearJobs } from "./test/jobQueueTestUtils.js";

const NOW = new Date("2099-06-11T02:00:00.000Z");
const later = (minutes: number) => new Date(NOW.getTime() + minutes * 60_000);

beforeEach(clearJobs);

describe("jobs store", () => {
  it("enqueues a job with its kind's priority, resources and lease", () => {
    const { job, coalesced } = enqueueJob(
      { kind: "ingest.hourly", dedupe_key: "ingest.hourly", payload: { slot: "s1" }, enqueued_by: "scheduler", reason: ":30 slot", not_before: NOW },
      NOW
    );
    expect(coalesced).toBe(false);
    expect(job).toMatchObject({ status: "queued", priority: 40, resources_json: '["ingest-service"]', lease_ms: 300_000, not_before: NOW.toISOString() });
    expect(jobPayload(job)).toEqual({ slot: "s1" });
  });

  it("coalesces a second enqueue with the same dedupe key into the queued row", () => {
    const first = enqueueJob({ kind: "deploy", dedupe_key: "deploy", payload: { sha: "a" }, enqueued_by: "deploy-agent", reason: "a" }, NOW).job;
    const second = enqueueJob({ kind: "deploy", dedupe_key: "deploy", payload: { sha: "b" }, enqueued_by: "deploy-agent", reason: "b" }, later(3));
    expect(second.coalesced).toBe(true);
    expect(second.job.id).toBe(first.id);
    expect(jobPayload(second.job)).toEqual({ sha: "b" });
    expect(listJobsByStatus("queued")).toHaveLength(1);
  });

  it("queues behind a running job with the same key instead of modifying it", () => {
    const first = enqueueJob({ kind: "deploy", dedupe_key: "deploy", payload: { sha: "a" }, enqueued_by: "deploy-agent", reason: "a" }, NOW).job;
    expect(claimJob(first.id, "deploy-agent", NOW)).toBe(true);
    const second = enqueueJob({ kind: "deploy", dedupe_key: "deploy", payload: { sha: "b" }, enqueued_by: "deploy-agent", reason: "b" }, later(1));
    expect(second.coalesced).toBe(false);
    expect(jobPayload(jobById(first.id)!)).toEqual({ sha: "a" });
  });

  it("claims a job once", () => {
    const { job } = enqueueJob({ kind: "ingest.nightly", dedupe_key: "ingest.nightly", payload: {}, enqueued_by: "scheduler", reason: "22:00" }, NOW);
    expect(claimJob(job.id, "server", NOW)).toBe(true);
    expect(claimJob(job.id, "server", NOW)).toBe(false);
    expect(jobById(job.id)).toMatchObject({ status: "running", worker: "server", claimed_at: NOW.toISOString(), heartbeat_at: NOW.toISOString() });
  });

  it("heartbeats only a running job", () => {
    const { job } = enqueueJob({ kind: "ingest.nightly", dedupe_key: null, payload: {}, enqueued_by: "scheduler", reason: "x" }, NOW);
    expect(heartbeatJob(job.id, later(1))).toBe(false);
    claimJob(job.id, "server", NOW);
    expect(heartbeatJob(job.id, later(1))).toBe(true);
    expect(jobById(job.id)!.heartbeat_at).toBe(later(1).toISOString());
    markJobLost(job.id, later(9), "silent");
    expect(heartbeatJob(job.id, later(10))).toBe(false);
  });

  it("releases a job its worker never took back to the queue, from a later start", () => {
    const { job } = enqueueJob({ kind: "ingest.hourly", dedupe_key: "ingest.hourly", payload: {}, enqueued_by: "scheduler", reason: "x" }, NOW);
    claimJob(job.id, "server", NOW);
    releaseJob(job.id, later(1), "busy");
    expect(jobById(job.id)).toMatchObject({ status: "queued", worker: null, claimed_at: null, not_before: later(1).toISOString(), error: "busy" });
    expect(() => releaseJob(job.id, later(2), "again")).toThrow(/not running/);
  });

  it("completes a running, a lost or a released job; refuses a finished one", () => {
    const mk = () => enqueueJob({ kind: "ingest.nightly", dedupe_key: null, payload: {}, enqueued_by: "scheduler", reason: "x" }, NOW).job;
    const a = mk();
    claimJob(a.id, "server", NOW);
    expect(completeJob(a.id, { ok: true, result: { exit: 0 } }, later(5))).toMatchObject({ status: "done", result_json: '{"exit":0}' });
    expect(() => completeJob(a.id, { ok: true }, later(6))).toThrow(/is done/);
    const b = mk();
    claimJob(b.id, "server", NOW);
    markJobLost(b.id, later(6), "silent");
    expect(completeJob(b.id, { ok: false, error: "late" }, later(7)).status).toBe("failed");
    const c = mk();
    expect(completeJob(c.id, { ok: true }, later(1))).toMatchObject({ status: "done", started_at: later(1).toISOString() });
  });

  it("supersedes and cancels only queued jobs", () => {
    const { job } = enqueueJob({ kind: "ingest.hourly", dedupe_key: "ingest.hourly", payload: {}, enqueued_by: "scheduler", reason: "x" }, NOW);
    claimJob(job.id, "server", NOW);
    expect(cancelJob(job.id, NOW)).toBe(false);
    expect(supersedeJob(job.id, NOW, "stale")).toBe(false);
    const q = enqueueJob({ kind: "ingest.hourly", dedupe_key: "ingest.hourly", payload: {}, enqueued_by: "scheduler", reason: "y" }, NOW).job;
    expect(cancelJob(q.id, NOW)).toBe(true);
    expect(jobById(q.id)!.status).toBe("cancelled");
    // A cancelled job no longer holds the dedupe key.
    expect(enqueueJob({ kind: "ingest.hourly", dedupe_key: "ingest.hourly", payload: {}, enqueued_by: "scheduler", reason: "z" }, NOW).coalesced).toBe(false);
  });
});
