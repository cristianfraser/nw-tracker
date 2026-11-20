/**
 * One SQLite file per Vitest fork (docs/test-speed-plan.md step 2).
 *
 * The base `nw-tracker.test.db` is generated (or migrated) once per run by `vitest.globalSetup.ts`
 * and is never opened by a test file. Each fork works on its own clone,
 * `nw-tracker.test.r<run>.w<N>.db`: <run> is the Vitest host process (so two runs in one checkout
 * never share a clone) and N the fork's `VITEST_POOL_ID` (Vitest reuses an id only after its
 * process exited). Imported by `vitest.config.ts`, the global setup and the worker setup file —
 * keep it free of server imports.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const BASE_TEST_DB = "nw-tracker.test.db";

/** Set on the workers of a per-worker run: the run id (the Vitest host's pid). */
export const TEST_RUN_ID_ENV = "NW_TRACKER_TEST_RUN_ID";

export const testDataDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "data");

const CLONE_RE = /^nw-tracker\.test\.r(\d+)\.w\d+\.db(-wal|-shm|-journal|\.tmp-\d+)?$/;

function requireDigits(label: string, value: string): string {
  if (!/^\d+$/.test(value)) throw new Error(`${label} must be a positive integer, got ${JSON.stringify(value)}`);
  return value;
}

export function workerTestDbName(runId: string, poolId: string): string {
  return `nw-tracker.test.r${requireDigits(TEST_RUN_ID_ENV, runId)}.w${requireDigits("VITEST_POOL_ID", poolId)}.db`;
}

/**
 * Physical cores (macOS `hw.physicalcpu`; elsewhere the logical count). Hyperthreads don't help:
 * on the 4-core / 8-thread home server 4, 6 and 8 forks ran the suite in 407, 415 and 409 s, and
 * above 4 a test's own time grew past Vitest's 5 s limit.
 */
function physicalCoreCount(): number {
  if (process.platform === "darwin") {
    const out = spawnSync("sysctl", ["-n", "hw.physicalcpu"], { encoding: "utf8" });
    const n = Number(out.stdout?.trim());
    if (out.status === 0 && Number.isInteger(n) && n > 0) return n;
    throw new Error(`sysctl -n hw.physicalcpu failed: ${out.stderr || out.error}`);
  }
  return os.availableParallelism();
}

/** Forks for a per-worker run: `NW_TRACKER_TEST_FORKS` when set, else one per physical core. */
export function testForkCount(): number {
  const raw = process.env.NW_TRACKER_TEST_FORKS?.trim();
  if (raw) {
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 1) throw new Error(`NW_TRACKER_TEST_FORKS must be a positive integer, got ${JSON.stringify(raw)}`);
    return n;
  }
  return physicalCoreCount();
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Remove clones: those of `runId` (a run's own teardown), or with no run id those whose run is
 * no longer alive (a run that was killed before its teardown). A live run's clones are left alone.
 */
export function removeWorkerTestDbs(runId?: string): void {
  if (!fs.existsSync(testDataDir)) return;
  for (const name of fs.readdirSync(testDataDir)) {
    const m = CLONE_RE.exec(name);
    if (!m) continue;
    const owner = m[1]!;
    if (runId ? owner === runId : !processAlive(Number(owner))) fs.rmSync(path.join(testDataDir, name), { force: true });
  }
}

/**
 * Clone the base for this fork when the run has not yet (APFS clones are instant and
 * copy-on-write; elsewhere `COPYFILE_FICLONE` falls back to a plain copy). Returns the clone's name.
 */
export function ensureWorkerTestDb(runId: string, poolId: string): string {
  const name = workerTestDbName(runId, poolId);
  const target = path.join(testDataDir, name);
  if (!fs.existsSync(target)) {
    const base = path.join(testDataDir, BASE_TEST_DB);
    if (!fs.existsSync(base)) throw new Error(`Base test DB ${base} is missing — the Vitest global setup creates it`);
    const tmp = `${target}.tmp-${process.pid}`;
    fs.copyFileSync(base, tmp, fs.constants.COPYFILE_FICLONE);
    fs.renameSync(tmp, target);
  }
  return name;
}
