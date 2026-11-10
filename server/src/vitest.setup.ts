/**
 * Runs once per Vitest worker before test files (after `db` is initialized).
 * `NW_TRACKER_TEST_DB` must be set before any import of `db` (see `vitest.config.ts` + `npm run test`).
 */
import { afterAll, beforeAll, beforeEach, expect } from "vitest";
import { clearAggregationCache } from "./cacheRegistry.js";
import { db } from "./db.js";
import { ensureVitestCreditCardFixtures } from "./test/vitestDbSeed.js";
import { ensureVitestInstrumentFixtures } from "./test/instrumentFixtures.js";
import { registerExpenseLinkSync } from "./expenseLinkSync.js";

ensureVitestCreditCardFixtures();
ensureVitestInstrumentFixtures();

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

/**
 * Derived state of the accounts a test file found on arrival (the Vitest person's, the fixture
 * card): stored marks, the owed walk's anchors and the card billing snapshots. A file that writes
 * through the card funnel leaves them changed for every later file — the credit-card group's Total
 * then read anchors and marks for months its cards no longer agreed on, and passed or failed by
 * file order. Each file gets them back as it found them; a file that changed them is named, so the
 * leak can be fixed where it happens.
 */
const DERIVED_ACCOUNT_TABLES = ["valuations", "cc_owed_anchors", "cc_billing_month_balances"] as const;

type DerivedSnapshot = { accountIds: number[]; rows: Map<string, Record<string, unknown>[]>; sourceRows: string };

/** The documents those accounts carry (card lines, movements): a file must not change them either. */
function sourceRowFingerprint(accountIds: readonly number[]): string {
  const ids = accountIds.length ? accountIds.join(",") : "NULL";
  const lines = db
    .prepare(
      `SELECT COUNT(*) AS n, COALESCE(SUM(l.id), 0) AS ids FROM cc_statement_lines l
       JOIN cc_statements s ON s.id = l.statement_id WHERE s.account_id IN (${ids})`
    )
    .get() as { n: number; ids: number };
  const movements = db
    .prepare(
      `SELECT COUNT(*) AS n, COALESCE(SUM(id), 0) AS ids FROM movements
       WHERE account_id IN (${ids}) OR from_account_id IN (${ids}) OR to_account_id IN (${ids})`
    )
    .get() as { n: number; ids: number };
  return `${lines.n}:${lines.ids}|${movements.n}:${movements.ids}`;
}

function readDerivedRows(accountIds: readonly number[]): Map<string, Record<string, unknown>[]> {
  const ids = accountIds.length ? accountIds.join(",") : "NULL";
  return new Map(
    DERIVED_ACCOUNT_TABLES.map((t) => [
      t,
      db.prepare(`SELECT * FROM ${t} WHERE account_id IN (${ids}) ORDER BY rowid`).all() as Record<string, unknown>[],
    ])
  );
}

let arrival: DerivedSnapshot | null = null;

beforeAll(() => {
  const accountIds = (db.prepare(`SELECT id FROM accounts ORDER BY id`).all() as { id: number }[]).map((r) => r.id);
  arrival = { accountIds, rows: readDerivedRows(accountIds), sourceRows: sourceRowFingerprint(accountIds) };
});

afterAll(() => {
  if (!arrival) return;
  const { accountIds, rows, sourceRows } = arrival;
  if (sourceRowFingerprint(accountIds) !== sourceRows) {
    console.warn(
      `[vitest.setup] ${expect.getState().testPath ?? "a test file"} left card lines or movements of accounts it did not create changed`
    );
  }
  const now = readDerivedRows(accountIds);
  const changed = DERIVED_ACCOUNT_TABLES.filter((t) => JSON.stringify(now.get(t)) !== JSON.stringify(rows.get(t)));
  if (changed.length === 0) return;
  console.warn(`[vitest.setup] ${expect.getState().testPath ?? "a test file"} changed ${changed.join(", ")} of accounts it did not create; restored`);
  const ids = accountIds.join(",");
  db.transaction(() => {
    for (const t of changed) {
      db.prepare(`DELETE FROM ${t} WHERE account_id IN (${ids})`).run();
      const list = rows.get(t)!;
      if (list.length === 0) continue;
      const cols = Object.keys(list[0]!);
      const insert = db.prepare(`INSERT INTO ${t} (${cols.join(", ")}) VALUES (${cols.map((c) => `@${c}`).join(", ")})`);
      for (const r of list) insert.run(r);
    }
  })();
  clearAggregationCache();
});
