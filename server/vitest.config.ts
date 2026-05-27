import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    /** Same process = one `db` module load; forks would race migrations on one SQLite file. */
    pool: "threads",
    /** Must be set before `db.ts` loads so Vitest never opens `nw-tracker.db`. */
    env: {
      NW_TRACKER_TEST_DB: "nw-tracker.test.db",
    },
    globalSetup: ["src/vitest.globalSetup.ts"],
    setupFiles: ["src/vitest.setup.ts"],
    maxWorkers: 1,
    minWorkers: 1,
  },
});
