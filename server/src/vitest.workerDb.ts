/**
 * First setup file: point this fork at its own clone of the test DB before anything imports
 * `db.ts` (`vitest.setup.ts` does, so this file must stay ahead of it in `setupFiles`).
 * Child processes a test spawns inherit the clone through the environment.
 */
import { ensureWorkerTestDb, TEST_RUN_ID_ENV } from "./test/workerTestDb.js";

const runId = process.env[TEST_RUN_ID_ENV]?.trim();
if (runId) {
  const poolId = process.env.VITEST_POOL_ID;
  if (!poolId) throw new Error(`${TEST_RUN_ID_ENV} is set but VITEST_POOL_ID is unset`);
  process.env.NW_TRACKER_TEST_DB = ensureWorkerTestDb(runId, poolId);
}
