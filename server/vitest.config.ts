import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import { BASE_TEST_DB, TEST_RUN_ID_ENV, testForkCount } from "./src/test/workerTestDb.js";

const configDir = path.dirname(fileURLToPath(import.meta.url));

/**
 * The default run (`npm run test`, NW_TRACKER_TEST_DB = the base file) gives every fork its own
 * clone of the base DB (`src/test/workerTestDb.ts`) and runs files in parallel. Any other
 * NW_TRACKER_TEST_DB set in the shell (a dev-DB copy, `:memory:`) is one database, so the run
 * falls back to a single fork.
 */
const requestedTestDb = process.env.NW_TRACKER_TEST_DB?.trim() || BASE_TEST_DB;
const perWorkerDb = requestedTestDb === BASE_TEST_DB;
const forks = perWorkerDb ? testForkCount() : 1;

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    /**
     * Forks (process isolation): better-sqlite3 in vitest worker threads segfaults
     * nondeterministically at thread teardown (native bindings + worker_threads).
     * Parallel forks are safe only because each opens its own DB file (see above).
     */
    pool: "forks",
    fileParallelism: forks > 1,
    /**
     * Files run in a random order (tests inside a file keep theirs), so a file that depends on
     * another's leftovers fails fast instead of passing by accident. The seed is printed at the
     * top of the run; reproduce an order with `--sequence.seed=<seed>`.
     */
    sequence: { shuffle: { files: true, tests: false } },
    poolOptions: {
      forks: {
        maxForks: forks,
        minForks: forks,
      },
    },
    /**
     * Must be set before `db.ts` loads so Vitest never opens `nw-tracker.db`.
     * `test.env` overrides the process env inside workers, so honor an explicit
     * shell-provided NW_TRACKER_TEST_DB (e.g. running the suite against a dev-DB
     * copy) instead of silently clobbering it. On a per-worker run `vitest.workerDb.ts`
     * then points each fork at its clone.
     */
    env: {
      NW_TRACKER_TEST_DB: requestedTestDb,
      // The config is evaluated in the Vitest host process: its pid names this run's clones.
      ...(perWorkerDb ? { [TEST_RUN_ID_ENV]: String(process.pid) } : {}),
      // Synthetic card registry — tests must never read the personal cfraser/cc-cards.json
      // (ccCardRegistry is read at module eval by ccConsolidatedCards, so set it here).
      NW_TRACKER_CC_CARDS: path.join(configDir, "src", "test", "ccCardsFixture.json"),
    },
    globalSetup: ["src/vitest.globalSetup.ts"],
    /** `vitest.workerDb.ts` picks the fork's DB and must run before anything imports `db.ts`. */
    setupFiles: ["src/vitest.workerDb.ts", "src/vitest.setup.ts"],
  },
});
