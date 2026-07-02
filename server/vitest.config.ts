import { defineConfig } from "vitest/config";

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
    /** Must be set before `db.ts` loads so Vitest never opens `nw-tracker.db`. */
    env: {
      NW_TRACKER_TEST_DB: "nw-tracker.test.db",
    },
    globalSetup: ["src/vitest.globalSetup.ts"],
    setupFiles: ["src/vitest.setup.ts"],
  },
});
