import { db } from "../db.js";
import { seedCreditCardTree } from "../seedCreditCardTree.js";

/** Isolated master account for Vitest (not used by real imports). */
export const VITEST_SANTANDER_CC_MASTER_NOTES = "credit_card_master|santander|vitest-fixture";

let vitestCreditCardFixturesApplied = false;

/**
 * Idempotent fixtures for Vitest: one Santander CC master so `importCcStatementsMerge` and similar
 * tests have a stable account without relying on `nw-tracker.db`.
 */
export function ensureVitestCreditCardFixtures(): void {
  if (!process.env.NW_TRACKER_TEST_DB?.trim()) {
    return;
  }
  if (vitestCreditCardFixturesApplied) {
    return;
  }

  const existing = db
    .prepare(`SELECT id FROM accounts WHERE notes = ?`)
    .get(VITEST_SANTANDER_CC_MASTER_NOTES) as { id: number } | undefined;

  if (!existing) {
    const bucket = db
      .prepare(
        `SELECT id FROM asset_groups WHERE slug IN ('credit_card', 'credit_cards__credit_card') LIMIT 1`
      )
      .get() as { id: number } | undefined;
    if (!bucket) {
      throw new Error(
        "Vitest DB seed failed: expected credit_card asset group (run migrations)."
      );
    }
    db.prepare(
      `INSERT INTO accounts (asset_group_id, name, notes, account_kind)
       VALUES (?, 'Vitest · santander · fixture', ?, 'master')`
    ).run(bucket.id, VITEST_SANTANDER_CC_MASTER_NOTES);
  }

  const accountId = (
    db.prepare(`SELECT id FROM accounts WHERE notes = ?`).get(VITEST_SANTANDER_CC_MASTER_NOTES) as {
      id: number;
    }
  ).id;

  const hasConfig = db
    .prepare(`SELECT 1 FROM credit_card_account_config WHERE account_id = ?`)
    .get(accountId) as { 1: number } | undefined;
  if (!hasConfig) {
    db.prepare(
      `INSERT INTO credit_card_account_config (account_id, billing_cycle_start_day, billing_cycle_end_day, card_last4)
       VALUES (?, 21, 20, '0000')`
    ).run(accountId);
  }

  seedCreditCardTree();
  vitestCreditCardFixturesApplied = true;
}

export function getVitestSantanderCcMasterAccountId(): number | null {
  if (!process.env.NW_TRACKER_TEST_DB?.trim()) {
    return null;
  }
  const row = db
    .prepare(`SELECT id FROM accounts WHERE notes = ?`)
    .get(VITEST_SANTANDER_CC_MASTER_NOTES) as { id: number } | undefined;
  return row?.id ?? null;
}

/**
 * Remove every data row tests accumulated on the fixture master (statements, ledger,
 * valuations, category rules). Call from `afterAll` in any file that writes to it —
 * leftover fixture data leaks into group totals and category lookups on later runs.
 */
export function wipeVitestCcFixtureData(): void {
  const account = db
    .prepare(`SELECT id FROM accounts WHERE notes = ?`)
    .get(VITEST_SANTANDER_CC_MASTER_NOTES) as { id: number } | undefined;
  if (!account) return;
  const id = account.id;
  db.prepare(
    `DELETE FROM cc_expense_line_categories WHERE statement_line_id IN (
       SELECT l.id FROM cc_statement_lines l JOIN cc_statements s ON s.id = l.statement_id
       WHERE s.account_id = ?)`
  ).run(id);
  db.prepare(
    `DELETE FROM cc_statement_lines WHERE statement_id IN (
       SELECT id FROM cc_statements WHERE account_id = ?)`
  ).run(id);
  db.prepare(`DELETE FROM cc_statements WHERE account_id = ?`).run(id);
  db.prepare(
    `DELETE FROM cc_installment_payments WHERE purchase_id IN (
       SELECT id FROM cc_installment_purchases WHERE account_id = ?)`
  ).run(id);
  db.prepare(`DELETE FROM cc_installment_purchases WHERE account_id = ?`).run(id);
  db.prepare(`DELETE FROM cc_billing_month_balances WHERE account_id = ?`).run(id);
  db.prepare(`DELETE FROM valuations WHERE account_id = ?`).run(id);
  db.prepare(`DELETE FROM cc_expense_merchant_categories WHERE account_id = ?`).run(id);
  db.prepare(`DELETE FROM cc_expense_unique_purchases WHERE account_id = ?`).run(id);
  db.prepare(`DELETE FROM cc_expense_purchase_notes WHERE account_id = ?`).run(id);
}
