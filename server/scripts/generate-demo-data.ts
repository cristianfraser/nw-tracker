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
import { DEFAULT_DEMO_NARRATIVE, demoRng } from "../src/demoData/demoNarrative.js";
import {
  initialDemoRunState,
  seedDemoMerchantCategoryRules,
  writeCheckingMonth,
  writeCreditCardMonth,
  writeInvestmentMonth,
  type DemoAccounts,
} from "../src/demoData/demoWriters.js";
import { expandYearMonthsInclusive } from "../src/calendarMonth.js";
import { recomputeCcBillingMonthBalances } from "../src/ccBillingBalances.js";
import { ensureAccountSyncSourcesSeeded } from "../src/accountSyncSources.js";

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

function createAccount(groupSlug: string, name: string, notes: string): number {
  return Number(
    db
      .prepare(`INSERT INTO accounts (asset_group_id, name, notes) VALUES (?, ?, ?)`)
      .run(assetGroupId(groupSlug), name, notes).lastInsertRowid
  );
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

function main(): void {
  assertFreshDemoDb();
  const { checkingId, ccMasterId } = createMasterAccounts();
  const accounts: DemoAccounts = {
    checkingId,
    ccMasterId,
    fondoId: createAccount(
      "brokerage_mutual_funds__fintual_risky_norris",
      "Fondo Demo Moderado",
      "demo:fondo"
    ),
    afpId: createAccount("retirement_afp_afc__afp", "AFP Demo · Fondo C", "demo:afp"),
    propertyId: createAccount("real_estate__property", "Depto propio (pie)", "demo:property"),
  };
  seedCreditCardTree();
  seedNavTree();

  const rng = demoRng(DEFAULT_DEMO_NARRATIVE.seed);
  const state = initialDemoRunState();
  const months = expandYearMonthsInclusive(
    DEFAULT_DEMO_NARRATIVE.firstMonth,
    DEFAULT_DEMO_NARRATIVE.lastMonth
  );
  for (const month of months) {
    const { sweepClp, afpContribClp } = writeCheckingMonth(accounts, month, state, rng);
    writeCreditCardMonth(accounts, month, state, rng);
    writeInvestmentMonth(accounts, month, state, sweepClp, afpContribClp, rng);
  }
  recomputeCcBillingMonthBalances(ccMasterId);
  seedDemoMerchantCategoryRules(ccMasterId);
  ensureAccountSyncSourcesSeeded();
  seedNavTree();

  const totals = db
    .prepare(
      `SELECT (SELECT COUNT(*) FROM movements) AS movs,
              (SELECT COUNT(*) FROM valuations) AS vals,
              (SELECT COUNT(*) FROM cc_statements) AS stmts,
              (SELECT COUNT(*) FROM cc_statement_lines) AS lines`
    )
    .get() as { movs: number; vals: number; stmts: number; lines: number };
  console.log(
    `demo data: ${months.length} months — ${totals.movs} movements, ${totals.vals} valuations, ` +
      `${totals.stmts} CC statements, ${totals.lines} CC lines`
  );
}

main();
