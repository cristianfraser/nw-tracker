import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.join(__dirname, "..", "data");

/**
 * When a local `nw-tracker.db` exists, seed `nw-tracker.test.db` from it once so Vitest
 * has realistic reference data without re-running data-heavy migrations on an empty file.
 * Delete `nw-tracker.test.db` to rebuild from migrations + `vitestDbSeed` instead.
 */
export default function vitestGlobalSetup(): void {
  const testBase = process.env.NW_TRACKER_TEST_DB?.trim() || "nw-tracker.test.db";
  if (testBase === ":memory:") return;

  const testPath = path.isAbsolute(testBase) ? testBase : path.join(dataDir, testBase);
  const prodPath = path.join(dataDir, "nw-tracker.db");

  if (fs.existsSync(testPath) || !fs.existsSync(prodPath)) {
    return;
  }

  fs.mkdirSync(dataDir, { recursive: true });
  fs.copyFileSync(prodPath, testPath);
  for (const ext of ["-wal", "-shm"]) {
    const from = prodPath + ext;
    if (fs.existsSync(from)) {
      fs.copyFileSync(from, testPath + ext);
    }
  }
}
