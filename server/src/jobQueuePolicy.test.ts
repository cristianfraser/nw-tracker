import { describe, expect, it } from "vitest";
import { coalesceQueued, leaseExpiresAt, pickNextJobs, type QueuedJob, type RunningJob } from "./jobQueuePolicy.js";

const NOW = new Date("2099-06-11T02:00:00.000Z");
const at = (minutes: number) => new Date(NOW.getTime() + minutes * 60_000).toISOString();

function queued(id: number, over: Partial<QueuedJob> = {}): QueuedJob {
  return { id, kind: "ingest.hourly", priority: 40, not_before: null, stale_after: null, resources: ["ingest-service"], created_at: at(-10), ...over };
}

function running(id: number, over: Partial<RunningJob> = {}): RunningJob {
  return { id, kind: "ingest.nightly", resources: ["ingest-service"], claimed_at: at(-3), heartbeat_at: at(-1), lease_ms: 5 * 60_000, ...over };
}

const startedIds = (d: ReturnType<typeof pickNextJobs>) => d.start.map((j) => j.id);

describe("pickNextJobs", () => {
  it("starts a due job when its resources are free", () => {
    const d = pickNextJobs([queued(1)], [], NOW);
    expect(startedIds(d)).toEqual([1]);
    expect(d.waiting).toEqual([]);
  });

  it("waits for a resource a running job holds, naming the holder", () => {
    const d = pickNextJobs([queued(1)], [running(7)], NOW);
    expect(d.start).toEqual([]);
    expect(d.waiting).toEqual([{ job: queued(1), reason: { code: "resource", resource: "ingest-service", held_by: { id: 7, kind: "ingest.nightly" } } }]);
  });

  it("starts jobs whose resources do not overlap side by side", () => {
    const d = pickNextJobs(
      [queued(1, { resources: ["bank:santander"] }), queued(2, { resources: ["mail"] })],
      [running(7, { resources: ["bank:afc"] })],
      NOW
    );
    expect(startedIds(d)).toEqual([1, 2]);
  });

  it("never grants one resource twice in a pass: the higher priority wins", () => {
    const d = pickNextJobs([queued(1, { priority: 40 }), queued(2, { kind: "ingest.nightly", priority: 50 })], [], NOW);
    expect(startedIds(d)).toEqual([2]);
    expect(d.waiting.map((w) => [w.job.id, w.reason])).toEqual([
      [1, { code: "resource", resource: "ingest-service", held_by: { id: 2, kind: "ingest.nightly" } }],
    ]);
  });

  it("orders equal priorities by not_before, then age, then id", () => {
    const q = [
      queued(3, { not_before: at(-1), created_at: at(-30) }),
      queued(2, { not_before: at(-5), created_at: at(-1) }),
      queued(4, { not_before: null, created_at: at(-2) }),
      queued(1, { not_before: null, created_at: at(-2) }),
    ];
    // One resource: only the first in order starts.
    expect(startedIds(pickNextJobs(q, [], NOW))).toEqual([1]);
    expect(startedIds(pickNextJobs(q.filter((j) => j.id !== 1), [], NOW))).toEqual([4]);
    expect(startedIds(pickNextJobs(q.filter((j) => j.id > 4 || j.id === 2 || j.id === 3), [], NOW))).toEqual([2]);
  });

  it("does not start a job before not_before, and lets a later one with the resource go first", () => {
    const d = pickNextJobs([queued(1, { priority: 50, not_before: at(5) }), queued(2, { priority: 40 })], [], NOW);
    expect(startedIds(d)).toEqual([2]);
    expect(d.waiting).toEqual([{ job: queued(1, { priority: 50, not_before: at(5) }), reason: { code: "not_before", at: at(5) } }]);
  });

  it("starts a job exactly at not_before", () => {
    expect(startedIds(pickNextJobs([queued(1, { not_before: NOW.toISOString() })], [], NOW))).toEqual([1]);
  });

  it("supersedes a queued job once stale_after has passed, and never starts it", () => {
    const stale = queued(1, { stale_after: NOW.toISOString() });
    const d = pickNextJobs([stale, queued(2, { stale_after: at(1) })], [], NOW);
    expect(d.superseded).toEqual([stale]);
    expect(startedIds(d)).toEqual([2]);
  });

  it("supersedes a stale job even while a resource it would need is held", () => {
    const d = pickNextJobs([queued(1, { stale_after: at(-1) })], [running(7)], NOW);
    expect(d.superseded.map((j) => j.id)).toEqual([1]);
    expect(d.waiting).toEqual([]);
  });

  describe("leases", () => {
    it("writes off a running job whose heartbeat is older than its lease, freeing its resources", () => {
      const silent = running(7, { heartbeat_at: at(-6) });
      const d = pickNextJobs([queued(1)], [silent], NOW);
      expect(d.lost).toEqual([silent]);
      expect(startedIds(d)).toEqual([1]);
    });

    it("measures from the claim when no heartbeat came yet", () => {
      const r = running(7, { heartbeat_at: null, claimed_at: at(-4) });
      expect(leaseExpiresAt(r)).toBe(NOW.getTime() + 60_000);
      expect(pickNextJobs([], [r], NOW).lost).toEqual([]);
      expect(pickNextJobs([], [r], new Date(NOW.getTime() + 60_000)).lost).toEqual([r]);
    });

    it("keeps a job with a fresh heartbeat running whatever its age", () => {
      const r = running(7, { claimed_at: at(-600), heartbeat_at: at(-4) });
      const d = pickNextJobs([queued(1)], [r], NOW);
      expect(d.lost).toEqual([]);
      expect(d.start).toEqual([]);
    });

    it("throws on a running job with neither a claim nor a heartbeat", () => {
      expect(() => pickNextJobs([], [running(7, { claimed_at: null, heartbeat_at: null })], NOW)).toThrow(/neither a claim nor a heartbeat/);
    });
  });

  describe("server-restart", () => {
    const deploy = (id: number, over: Partial<QueuedJob> = {}) =>
      queued(id, { kind: "deploy", priority: 100, resources: ["server-restart"], ...over });

    it("is granted when nothing runs", () => {
      expect(startedIds(pickNextJobs([deploy(1), queued(2)], [], NOW))).toEqual([1]);
    });

    it("waits while anything runs, and drains the queue: nothing of lower priority starts", () => {
      const d = pickNextJobs([deploy(1), queued(2, { resources: ["mail"] })], [running(7, { resources: ["bank:afc"] })], NOW);
      expect(d.start).toEqual([]);
      expect(d.waiting.map((w) => [w.job.id, w.reason.code])).toEqual([
        [1, "resource"],
        [2, "draining"],
      ]);
      expect(d.waiting[0]!.reason).toEqual({ code: "resource", resource: "server-restart", held_by: { id: 7, kind: "ingest.nightly" } });
      expect(d.waiting[1]!.reason).toEqual({ code: "draining", for_job: { id: 1, kind: "deploy" } });
    });

    it("does not drain before the restart job is due", () => {
      const d = pickNextJobs([deploy(1, { not_before: at(10) }), queued(2)], [], NOW);
      expect(startedIds(d)).toEqual([2]);
    });

    it("while held, keeps every other job waiting, unrelated resources included", () => {
      const held = running(9, { kind: "deploy", resources: ["server-restart"], lease_ms: 20 * 60_000 });
      const d = pickNextJobs([queued(1, { kind: "ingest.nightly", priority: 50 }), queued(2, { resources: [] })], [held], NOW);
      expect(d.start).toEqual([]);
      expect(d.waiting.map((w) => w.reason)).toEqual([
        { code: "exclusive", held_by: { id: 9, kind: "deploy" } },
        { code: "exclusive", held_by: { id: 9, kind: "deploy" } },
      ]);
    });

    it("frees the queue when the restart job's lease runs out", () => {
      const held = running(9, { kind: "deploy", resources: ["server-restart"], lease_ms: 20 * 60_000, heartbeat_at: at(-21) });
      const d = pickNextJobs([queued(1)], [held], NOW);
      expect(d.lost).toEqual([held]);
      expect(startedIds(d)).toEqual([1]);
    });

    it("a lower-priority restart job does not jump a due higher-priority job", () => {
      const d = pickNextJobs([deploy(1, { priority: 10 }), queued(2, { priority: 50 })], [], NOW);
      expect(startedIds(d)).toEqual([2]);
      expect(d.waiting[0]!.reason).toEqual({ code: "resource", resource: "server-restart", held_by: { id: 2, kind: "ingest.hourly" } });
    });
  });
});

describe("coalesceQueued", () => {
  const base = { payload_json: '{"slot":"a"}', reason: "first", enqueued_by: "scheduler", priority: 40, not_before: at(0), stale_after: at(60) };

  it("takes the newest payload and reason, the earlier start and the newer staleness", () => {
    expect(coalesceQueued(base, { payload_json: '{"slot":"b"}', reason: "second", enqueued_by: "scheduler", priority: 40, not_before: at(60), stale_after: at(120) })).toEqual({
      payload_json: '{"slot":"b"}',
      reason: "second",
      enqueued_by: "scheduler",
      priority: 40,
      not_before: at(0),
      stale_after: at(120),
    });
  });

  it("a manual request starts it now and keeps the higher priority", () => {
    const merged = coalesceQueued({ ...base, not_before: at(30) }, { ...base, enqueued_by: "manual", priority: 30, not_before: at(-1) });
    expect(merged.not_before).toBe(at(-1));
    expect(merged.priority).toBe(40);
    expect(merged.enqueued_by).toBe("manual");
  });

  it("no not_before on either side means it may start at once", () => {
    expect(coalesceQueued({ ...base, not_before: null }, base).not_before).toBeNull();
    expect(coalesceQueued(base, { ...base, not_before: null }).not_before).toBeNull();
  });
});
