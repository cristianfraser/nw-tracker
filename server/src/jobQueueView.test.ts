import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { db } from "./db.js";
import { SCHEDULER_ENQUEUED_BY, enqueueIngestRun } from "./ingestRunScheduler.js";
import { claimJob, jobById, markJobLost } from "./jobQueue.js";
import { buildJobQueuePayload, cancelQueuedJob, retryJob } from "./jobQueueView.js";
import { clearJobs } from "./test/jobQueueTestUtils.js";

const T0 = new Date("2099-06-11T02:00:00.000Z");
const at = (minutes: number) => new Date(T0.getTime() + minutes * 60_000);

function clear() {
  clearJobs();
  db.prepare(`DELETE FROM ingest_runs`).run();
}

const previousFlag = process.env.INGEST_SCHEDULER_ENABLED;
beforeEach(() => {
  clear();
  process.env.INGEST_SCHEDULER_ENABLED = "1";
});
afterEach(() => {
  clear();
  if (previousFlag === undefined) delete process.env.INGEST_SCHEDULER_ENABLED;
  else process.env.INGEST_SCHEDULER_ENABLED = previousFlag;
});

describe("job queue view", () => {
  it("shows what runs, what waits and why (structured), and which actions apply", () => {
    const nightly = enqueueIngestRun("nightly", T0, "22:00 slot", SCHEDULER_ENQUEUED_BY, T0).job;
    claimJob(nightly.id, "ingest-service", at(29));
    const hourly = enqueueIngestRun("hourly", at(30), ":30 slot", SCHEDULER_ENQUEUED_BY, at(30)).job;
    const p = buildJobQueuePayload(at(31));
    expect(p.running).toEqual([
      expect.objectContaining({ id: nightly.id, kind_slug: "ingest_nightly", worker: "ingest-service", lease_expires_at: at(34).toISOString(), can_cancel: false, can_retry: false }),
    ]);
    expect(p.queued).toEqual([
      expect.objectContaining({
        id: hourly.id,
        kind_slug: "ingest_hourly",
        can_cancel: true,
        waiting: { code: "resource", resource: "ingest-service", held_by: { id: nightly.id, kind_slug: "ingest_nightly" } },
      }),
    ]);
  });

  it("cancels a queued job only, recording its slot as skipped", () => {
    const hourly = enqueueIngestRun("hourly", T0, ":30 slot", SCHEDULER_ENQUEUED_BY, T0).job;
    expect(cancelQueuedJob(hourly.id, at(1))).toEqual({ ok: true });
    expect(jobById(hourly.id)!.status).toBe("cancelled");
    expect(db.prepare(`SELECT status, job_id FROM ingest_runs WHERE kind = 'hourly'`).get()).toEqual({ status: "skipped", job_id: hourly.id });
    expect(cancelQueuedJob(hourly.id, at(2))).toMatchObject({ ok: false, status: 409 });
    expect(cancelQueuedJob(999_999, at(2))).toMatchObject({ ok: false, status: 404 });
    expect(buildJobQueuePayload(at(3)).recent[0]).toMatchObject({ id: hourly.id, status: "cancelled", can_retry: false });
  });

  it("retries a lost ingest run as a manual run queued now", () => {
    const nightly = enqueueIngestRun("nightly", T0, "22:00 slot", SCHEDULER_ENQUEUED_BY, T0).job;
    expect(retryJob(nightly.id, at(1))).toMatchObject({ ok: false, status: 409 });
    claimJob(nightly.id, "ingest-service", T0);
    markJobLost(nightly.id, at(6), "silent");
    expect(buildJobQueuePayload(at(7)).recent[0]).toMatchObject({ id: nightly.id, can_retry: true });
    expect(retryJob(nightly.id, at(7))).toEqual({ ok: true });
    const queued = buildJobQueuePayload(at(7)).queued;
    expect(queued).toEqual([expect.objectContaining({ kind_slug: "ingest_nightly", enqueued_by: "manual", reason: `manual: retry of job ${nightly.id}`, waiting: null })]);
  });
});
