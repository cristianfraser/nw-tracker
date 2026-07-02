/**
 * Generate a synthetic demo DB for the hosted recruiter deployment.
 *
 *   NW_TRACKER_TEST_DB=/abs/path/demo.db npx tsx scripts/generate-demo-data.ts
 *
 * SAFETY: refuses to run against a DB that already has accounts — point
 * NW_TRACKER_TEST_DB at a fresh file. Never run against nw-tracker.db.
 *
 * Current state (groundwork): creates the two master accounts everything hangs off
 * (one checking account + one CC master with billing config + nav trees) and walks the
 * narrative month by month. The three writers below are stubs — see TODOs. Design notes
 * in src/demoData/demoNarrative.ts.
 */
import { db } from "../src/db.js";
import { seedNavTree } from "../src/seedNavTree.js";
import { seedCreditCardTree } from "../src/seedCreditCardTree.js";
import {
  DEFAULT_DEMO_NARRATIVE,
  chapterForMonth,
  demoRng,
  type DemoMonth,
} from "../src/demoData/demoNarrative.js";
import { expandYearMonthsInclusive } from "../src/calendarMonth.js";

const DEMO_CHECKING_NOTES = "demo:checking";
const DEMO_CC_MASTER_NOTES = "credit_card_master|santander|demo-4321";

function assertFreshDemoDb(): void {
  if (!process.env.NW_TRACKER_TEST_DB?.trim()) {
    throw new Error(
      "Set NW_TRACKER_TEST_DB to a fresh demo DB file (refusing to touch nw-tracker.db)."
    );
  }
  const n = (db.prepare(`SELECT COUNT(*) AS c FROM accounts`).get() as { c: number }).c;
  if (n > 0) {
    throw new Error(`demo DB already has ${n} accounts — point NW_TRACKER_TEST_DB at a fresh file.`);
  }
}

function assetGroupId(slug: string): number {
  const row = db.prepare(`SELECT id FROM asset_groups WHERE slug = ?`).get(slug) as
    | { id: number }
    | undefined;
  if (!row) throw new Error(`asset_groups slug missing: ${slug} (schema seed incomplete?)`);
  return row.id;
}

function createMasterAccounts(): { checkingId: number; ccMasterId: number } {
  const checkingId = Number(
    db
      .prepare(`INSERT INTO accounts (asset_group_id, name, notes) VALUES (?, ?, ?)`)
      .run(
        assetGroupId("cash_eqs__checking_accounts__cuenta_corriente"),
        "Cuenta corriente · Demo Bank",
        DEMO_CHECKING_NOTES
      ).lastInsertRowid
  );
  const ccMasterId = Number(
    db
      .prepare(`INSERT INTO accounts (asset_group_id, name, notes, account_kind) VALUES (?, ?, ?, 'master')`)
      .run(assetGroupId("credit_cards__credit_card"), "Tarjeta · Demo Bank 4321", DEMO_CC_MASTER_NOTES)
      .lastInsertRowid
  );
  db.prepare(
    `INSERT INTO credit_card_account_config (account_id, billing_cycle_start_day, billing_cycle_end_day, card_last4)
     VALUES (?, 21, 20, '4321')`
  ).run(ccMasterId);
  return { checkingId, ccMasterId };
}

/* ---------------------------------------------------------------------------------- */
/* Month writers — the actual generation work. Each must produce data through the same */
/* tables the real imports write, so every reconciliation invariant holds by design.   */
/* ---------------------------------------------------------------------------------- */

function writeChackingMonth(_checkingId: number, month: DemoMonth, rng: () => number): void {
  const ch = chapterForMonth(DEFAULT_DEMO_NARRATIVE, month);
  void ch;
  void rng;
  // TODO(demo): insert checking `movements` — salary abono (~day 25), fixed-expense
  // cargos, CC PAGO cargo matching the prior billing month's facturado, and the monthly
  // sweep transfer to savings/investments (from/to transfer rows). Amounts from the
  // chapter ± rng jitter. Keep a running balance and write month-end `valuations`.
}

function writeCreditCardMonth(_ccMasterId: number, month: DemoMonth, rng: () => number): void {
  const ch = chapterForMonth(DEFAULT_DEMO_NARRATIVE, month);
  void ch;
  void rng;
  // TODO(demo): insert one `cc_statements` row per billing month (period 21→20, canonical
  // source_pdf naming from importSyncDocumentFilePath conventions or web-paste source) and
  // `cc_statement_lines` drawn from a demo merchant pool weighted by chapter
  // categoryWeights; narrative events with `cuotas` become installment lines so the
  // billing/installment views light up. Then recomputeCcBillingMonthBalances(ccMasterId).
}

function writeInvestmentMonth(month: DemoMonth, rng: () => number): void {
  void month;
  void rng;
  // TODO(demo): a simple brokerage account (equity_ticker e.g. SPY) receiving the sweep
  // as buy movements + month-end valuations from a synthetic price walk, so charts,
  // deposits reconciliation, and P/L tabs have content. Optionally an AFP-like account
  // fed by a fixed % of salary.
}

function main(): void {
  assertFreshDemoDb();
  const { checkingId, ccMasterId } = createMasterAccounts();
  seedCreditCardTree();
  seedNavTree();

  const rng = demoRng(DEFAULT_DEMO_NARRATIVE.seed);
  const months = expandYearMonthsInclusive(
    DEFAULT_DEMO_NARRATIVE.firstMonth,
    DEFAULT_DEMO_NARRATIVE.lastMonth
  );
  for (const month of months) {
    writeChackingMonth(checkingId, month, rng);
    writeCreditCardMonth(ccMasterId, month, rng);
    writeInvestmentMonth(month, rng);
  }
  seedNavTree();
  console.log(
    `demo data: ${months.length} months scaffolded for checking=${checkingId} cc=${ccMasterId} (writers are TODO stubs)`
  );
}

main();
