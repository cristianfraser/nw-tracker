/**
 * Runs once per Vitest worker before test files (after `db` is initialized).
 * `NW_TRACKER_TEST_DB` must be set before any import of `db` (see `vitest.config.ts` + `npm run test`).
 */
import { beforeAll, beforeEach } from "vitest";
import { clearAggregationCache } from "./cacheRegistry.js";
import { ensureVitestCreditCardFixtures } from "./test/vitestDbSeed.js";
import { registerExpenseLinkSync } from "./expenseLinkSync.js";

ensureVitestCreditCardFixtures();

/**
 * The card-line funnel registers its frame when it loads, so a test that writes card lines through
 * a lower-level writer (the merge, a reconcile) still finishes through it. Loaded once the test
 * file's own imports (and its `vi.mock`s) are in: a static import here would load half the server
 * ahead of a test's mocks.
 *
 * The expense deposit-link sync rebuilds every expense line of the database after each write
 * (`expenseLinkSync.ts`); test fixtures write partial card ledgers that are no expense lines'
 * business. Tests about the links run the sync themselves (`syncExpenseLinksNow`) — the write the
 * page's reads used to hide.
 */
beforeAll(async () => {
  await import("./cards/lineWrites.js");
  registerExpenseLinkSync(() => undefined);
});

/**
 * In-process derived-state caches survive across tests within a file (and across files
 * sharing a fork). Tests that write movements/valuations without going through the
 * invalidation hooks leave stale aggregates behind, making a handful of reconciliation
 * tests order-dependent (pass in isolation, fail in the full run). Start every test cold.
 */
beforeEach(() => {
  clearAggregationCache();
});
