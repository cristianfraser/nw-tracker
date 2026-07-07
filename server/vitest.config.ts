import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const configDir = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    /**
     * Forks (process isolation), strictly one at a time: better-sqlite3 in vitest worker
     * threads segfaults nondeterministically at thread teardown (native bindings +
     * worker_threads), killing the run after a few files. One fork at a time keeps the
     * single-SQLite-file sequencing the threads+maxWorkers=1 setup provided — parallel
     * forks would race migrations and shared-state tests on one DB file.
     */
    pool: "forks",
    fileParallelism: false,
    poolOptions: {
      forks: {
        maxForks: 1,
        minForks: 1,
      },
    },
    /**
     * Must be set before `db.ts` loads so Vitest never opens `nw-tracker.db`.
     * `test.env` overrides the process env inside workers, so honor an explicit
     * shell-provided NW_TRACKER_TEST_DB (e.g. running the suite against a dev-DB
     * copy) instead of silently clobbering it.
     */
    env: {
      NW_TRACKER_TEST_DB: process.env.NW_TRACKER_TEST_DB?.trim() || "nw-tracker.test.db",
      // Synthetic card registry — tests must never read the personal cfraser/cc-cards.json
      // (ccCardRegistry is read at module eval by ccConsolidatedCards, so set it here).
      NW_TRACKER_CC_CARDS: path.join(configDir, "src", "test", "ccCardsFixture.json"),
    },
    globalSetup: ["src/vitest.globalSetup.ts"],
    setupFiles: ["src/vitest.setup.ts"],
  },
});
