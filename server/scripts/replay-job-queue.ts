/**
 * Replay recorded ingest slots through the job queue's policy (docs/job-queue-plan.md, phase 1),
 * in memory: nothing is written. For each minute of the window the hourly (:30) and nightly
 * (22:00) slots are enqueued as the scheduler does (one queued job per kind, coalescing), a job
 * that starts runs for as long as the recorded run of its slot took (`ingest_runs`), and deploy
 * pushes given with `--deploy` hold `server-restart` for `--deploy-minutes`. Prints each start,
 * coalesce and supersede, and how late each job started.
 *
 *   NW_TRACKER_TEST_DB=<copy>.db npx tsx scripts/replay-job-queue.ts --from=2026-10-29T12:00:00Z --hours=24 \
 *     [--deploy=2026-10-30T01:40:00Z,2026-10-30T01:45:00Z] [--deploy-minutes=6]
 */
import { db } from "../src/db.js";
import { JOB_KINDS } from "../src/jobQueue.js";
import { coalesceQueued, pickNextJobs, type QueuedJob, type RunningJob } from "../src/jobQueuePolicy.js";
import { hourlySlotAtOrBefore, nightlySlotAtOrBefore } from "../src/ingestRunPolicy.js";

function arg(name: string): string | undefined {
  return process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
}

const from = new Date(arg("from") ?? new Date(Date.now() - 24 * 3_600_000).toISOString());
const hours = Number(arg("hours") ?? 24);
const deployAt = (arg("deploy") ?? "").split(",").filter(Boolean).map((s) => new Date(s).getTime());
const deployMinutes = Number(arg("deploy-minutes") ?? 6);
if (Number.isNaN(from.getTime()) || !(hours > 0)) throw new Error("bad --from / --hours");

const recorded = db
  .prepare(`SELECT kind, slot_at, started_at, finished_at FROM ingest_runs WHERE started_at IS NOT NULL AND finished_at IS NOT NULL`)
  .all() as { kind: string; slot_at: string; started_at: string; finished_at: string }[];
const durationBySlot = new Map(recorded.map((r) => [`${r.kind}|${r.slot_at}`, new Date(r.finished_at).getTime() - new Date(r.started_at).getTime()]));
const median = (kind: string) => {
  const d = recorded.filter((r) => r.kind === kind).map((r) => new Date(r.finished_at).getTime() - new Date(r.started_at).getTime()).sort((a, b) => a - b);
  return d.length ? d[Math.floor(d.length / 2)]! : 60_000;
};
const fallback = { "ingest.hourly": median("hourly"), "ingest.nightly": median("nightly"), deploy: deployMinutes * 60_000 };

type SimJob = QueuedJob & { slot: string; payload_json: string; reason: string; enqueued_by: string; dedupe_key: string; enqueued_at: number };
type SimRunning = RunningJob & { ends: number; slot: string; startedLate: number };
const queue: SimJob[] = [];
const running: SimRunning[] = [];
let nextId = 1;
const lines: string[] = [];
const waits: { kind: string; slot: string; lateMin: number }[] = [];
let coalesced = 0;
let superseded = 0;
const enqueued = new Set<string>();

function enqueue(kind: keyof typeof JOB_KINDS, slot: Date, now: number, staleAfter: Date | null) {
  const key = `${kind}|${slot.toISOString()}`;
  if (enqueued.has(key)) return;
  enqueued.add(key);
  const def = JOB_KINDS[kind];
  const incoming = {
    payload_json: JSON.stringify({ slot: slot.toISOString() }),
    reason: "scheduler",
    enqueued_by: "scheduler",
    priority: def.priority,
    not_before: slot.toISOString(),
    stale_after: staleAfter ? staleAfter.toISOString() : null,
  };
  const existing = queue.find((j) => j.dedupe_key === kind);
  if (existing) {
    Object.assign(existing, coalesceQueued(existing, incoming), { slot: slot.toISOString() });
    coalesced++;
    lines.push(`${new Date(now).toISOString()}  coalesce ${kind} ${existing.id} → slot ${slot.toISOString()}`);
    return;
  }
  queue.push({ id: nextId++, kind, dedupe_key: kind, resources: def.resources, created_at: new Date(now).toISOString(), slot: slot.toISOString(), enqueued_at: now, ...incoming });
}

const end = from.getTime() + hours * 3_600_000;
for (let t = from.getTime(); t <= end; t += 60_000) {
  const now = new Date(t);
  for (let i = running.length - 1; i >= 0; i--) {
    if (running[i]!.ends <= t) {
      lines.push(`${now.toISOString()}  finish ${running[i]!.kind} ${running[i]!.id}`);
      running.splice(i, 1);
    }
  }
  const hourly = hourlySlotAtOrBefore(now);
  if (hourly.getTime() >= from.getTime()) enqueue("ingest.hourly", hourly, t, new Date(hourly.getTime() + 3_600_000));
  const nightly = nightlySlotAtOrBefore(now);
  if (nightly.getTime() >= from.getTime()) enqueue("ingest.nightly", nightly, t, null);
  for (const d of deployAt) if (d <= t && d > t - 60_000) enqueue("deploy", new Date(d), t, null);

  // The simulated workers heartbeat every minute.
  for (const r of running) r.heartbeat_at = now.toISOString();
  const decision = pickNextJobs(queue, running, now);
  for (const s of decision.superseded) {
    superseded++;
    lines.push(`${now.toISOString()}  supersede ${s.kind} ${s.id}`);
    queue.splice(queue.findIndex((j) => j.id === s.id), 1);
  }
  for (const s of decision.start) {
    const job = queue.splice(queue.findIndex((j) => j.id === s.id), 1)[0]!;
    const slotKey = `${job.kind.replace("ingest.", "")}|${job.slot}`;
    const duration = durationBySlot.get(slotKey) ?? fallback[job.kind as keyof typeof fallback];
    const lateMin = Math.round((t - new Date(job.slot).getTime()) / 60_000);
    waits.push({ kind: job.kind, slot: job.slot, lateMin });
    running.push({ id: job.id, kind: job.kind, resources: job.resources, claimed_at: now.toISOString(), heartbeat_at: now.toISOString(), lease_ms: JOB_KINDS[job.kind as keyof typeof JOB_KINDS].lease_ms, ends: t + duration, slot: job.slot, startedLate: lateMin });
    lines.push(`${now.toISOString()}  start ${job.kind} ${job.id} (slot ${job.slot}, ${lateMin} min late, runs ${Math.round(duration / 60_000)} min)`);
  }
}

console.log(lines.join("\n"));
const byKind = (k: string) => waits.filter((w) => w.kind === k);
console.log("\nSummary");
for (const k of Object.keys(JOB_KINDS)) {
  const w = byKind(k);
  if (!w.length) continue;
  console.log(`  ${k}: ${w.length} started, max ${Math.max(...w.map((x) => x.lateMin))} min late, ${w.filter((x) => x.lateMin > 2).length} more than 2 min late`);
}
console.log(`  coalesced ${coalesced}, superseded ${superseded}, still queued ${queue.length}, still running ${running.length}`);
