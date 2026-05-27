/**
 * Runs once per Vitest worker before test files (after `db` is initialized).
 * `NW_TRACKER_TEST_DB` must be set before any import of `db` (see `vitest.config.ts` + `npm run test`).
 */
import { ensureVitestCreditCardFixtures } from "./test/vitestDbSeed.js";

ensureVitestCreditCardFixtures();
