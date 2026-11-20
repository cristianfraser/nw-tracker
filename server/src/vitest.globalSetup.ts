import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { BASE_TEST_DB, removeWorkerTestDbs } from "./test/workerTestDb.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverDir = path.join(__dirname, "..");
const dataDir = path.join(serverDir, "data");

function findTsx(): string {
  // npm workspaces hoist tsx to the root node_modules; fall back to a server-local one.
  const tsxCandidates = [
    path.join(serverDir, "..", "node_modules", ".bin", "tsx"),
    path.join(serverDir, "node_modules", ".bin", "tsx"),
  ];
  const tsx = tsxCandidates.find((p) => fs.existsSync(p));
  if (!tsx) {
    throw new Error(`vitest globalSetup: tsx binary not found (looked in ${tsxCandidates.join(", ")})`);
  }
  return tsx;
}

/**
 * Missing `nw-tracker.test.db` → generate the Vitest person (`testPerson`, src/demoData; tests must not
 * depend on personal data — see the demoData generator). Delete the test DB to rebuild.
 *
 * Escape hatch: `NW_TRACKER_TEST_FROM_DEV=1` restores the old behavior of copying the
 * local `nw-tracker.db` (useful when reproducing an issue against real data locally).
 */
function createTestDb(testPath: string): void {
  fs.mkdirSync(dataDir, { recursive: true });

  if (process.env.NW_TRACKER_TEST_FROM_DEV === "1") {
    const prodPath = path.join(dataDir, "nw-tracker.db");
    if (!fs.existsSync(prodPath)) {
      throw new Error("NW_TRACKER_TEST_FROM_DEV=1 but nw-tracker.db does not exist");
    }
    fs.copyFileSync(prodPath, testPath);
    for (const ext of ["-wal", "-shm"]) {
      const from = prodPath + ext;
      if (fs.existsSync(from)) fs.copyFileSync(from, testPath + ext);
    }
    return;
  }

  // Child process so the generator's db.ts import binds to the fresh file without
  // polluting the vitest host process.
  const script = path.join(serverDir, "scripts", "generate-demo-data.ts");
  const r = spawnSync(findTsx(), [script, "--test"], {
    cwd: serverDir,
    env: { ...process.env, NW_TRACKER_TEST_DB: testPath },
    stdio: "inherit",
  });
  if (r.status !== 0) {
    throw new Error(`vitest globalSetup: synthetic test DB generation failed (exit ${r.status})`);
  }
}

/**
 * Per-worker run (docs/test-speed-plan.md step 2): the forks clone the base and never open it,
 * so it must be current before they do — apply any migration newer than the base in a child
 * process (`db.ts` migrates on import) and fold the WAL into the main file (a clone copies the
 * main file only). Clones left by runs that died before their teardown are removed.
 */
function prepareBaseForClones(testPath: string): void {
  const r = spawnSync(findTsx(), ["-e", "import './src/db.ts'"], {
    cwd: serverDir,
    env: { ...process.env, NW_TRACKER_TEST_DB: testPath },
    stdio: "inherit",
  });
  if (r.status !== 0) throw new Error(`vitest globalSetup: migrating the base test DB failed (exit ${r.status})`);
  const base = new Database(testPath);
  try {
    base.pragma("wal_checkpoint(TRUNCATE)");
  } finally {
    base.close();
  }
  removeWorkerTestDbs();
}

export default function vitestGlobalSetup(): (() => void) | undefined {
  const testBase = process.env.NW_TRACKER_TEST_DB?.trim() || BASE_TEST_DB;
  if (testBase === ":memory:") return undefined;

  const testPath = path.isAbsolute(testBase) ? testBase : path.join(dataDir, testBase);
  if (!fs.existsSync(testPath)) createTestDb(testPath);
  if (testBase !== BASE_TEST_DB) return undefined;
  prepareBaseForClones(testPath);
  // The global setup runs in the Vitest host, whose pid names this run's clones (vitest.config.ts).
  const runId = String(process.pid);
  return () => removeWorkerTestDbs(runId);
}
