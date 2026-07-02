/**
 * Runs once per Vitest worker before test files (after `db` is initialized).
 * `NW_TRACKER_TEST_DB` must be set before any import of `db` (see `vitest.config.ts` + `npm run test`).
 */
import { beforeEach } from "vitest";
import { clearAggregationCache } from "./aggregationCache.js";
import { ensureVitestCreditCardFixtures } from "./test/vitestDbSeed.js";

ensureVitestCreditCardFixtures();

/**
 * In-process derived-state caches survive across tests within a file (and across files
 * sharing a fork). Tests that write movements/valuations without going through the
 * invalidation hooks leave stale aggregates behind, making a handful of reconciliation
 * tests order-dependent (pass in isolation, fail in the full run). Start every test cold.
 */
beforeEach(() => {
  clearAggregationCache();
});
