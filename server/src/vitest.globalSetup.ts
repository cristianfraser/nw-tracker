import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverDir = path.join(__dirname, "..");
const dataDir = path.join(serverDir, "data");

/**
 * Missing `nw-tracker.test.db` → generate the lean synthetic preset (tests must not
 * depend on personal data — see the demoData generator). Delete the test DB to rebuild.
 *
 * Escape hatch: `NW_TRACKER_TEST_FROM_DEV=1` restores the old behavior of copying the
 * local `nw-tracker.db` (useful when reproducing an issue against real data locally).
 */
export default function vitestGlobalSetup(): void {
  const testBase = process.env.NW_TRACKER_TEST_DB?.trim() || "nw-tracker.test.db";
  if (testBase === ":memory:") return;

  const testPath = path.isAbsolute(testBase) ? testBase : path.join(dataDir, testBase);
  if (fs.existsSync(testPath)) return;
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
  // npm workspaces hoist tsx to the root node_modules; fall back to a server-local one.
  const tsxCandidates = [
    path.join(serverDir, "..", "node_modules", ".bin", "tsx"),
    path.join(serverDir, "node_modules", ".bin", "tsx"),
  ];
  const tsx = tsxCandidates.find((p) => fs.existsSync(p));
  if (!tsx) {
    throw new Error(`vitest globalSetup: tsx binary not found (looked in ${tsxCandidates.join(", ")})`);
  }
  const script = path.join(serverDir, "scripts", "generate-demo-data.ts");
  const r = spawnSync(tsx, [script, "--preset=test"], {
    cwd: serverDir,
    env: { ...process.env, NW_TRACKER_TEST_DB: testPath },
    stdio: "inherit",
  });
  if (r.status !== 0) {
    throw new Error(`vitest globalSetup: synthetic test DB generation failed (exit ${r.status})`);
  }
}
