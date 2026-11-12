import { db } from "../db.js";
import { seedLiabilitiesTree } from "../seedLiabilitiesTree.js";

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
    .prepare(`SELECT id FROM accounts WHERE import_key = ?`)
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
      `INSERT INTO accounts (asset_group_id, name, notes, import_key)
       VALUES (?, 'Vitest · santander · fixture', ?, ?)`
    ).run(bucket.id, VITEST_SANTANDER_CC_MASTER_NOTES, VITEST_SANTANDER_CC_MASTER_NOTES);
  }

  const accountId = (
    db.prepare(`SELECT id FROM accounts WHERE import_key = ?`).get(VITEST_SANTANDER_CC_MASTER_NOTES) as {
      id: number;
    }
  ).id;

  const hasConfig = db
    .prepare(`SELECT 1 FROM credit_card_account_config WHERE account_id = ?`)
    .get(accountId) as { 1: number } | undefined;
  if (!hasConfig) {
    db.prepare(
      `INSERT INTO credit_card_account_config (account_id, billing_cycle_start_day, billing_cycle_end_day, card_last4, issuer)
       VALUES (?, 21, 20, '0000', 'santander')`
    ).run(accountId);
  }

  seedLiabilitiesTree();
  vitestCreditCardFixturesApplied = true;
}

export function getVitestSantanderCcMasterAccountId(): number | null {
  if (!process.env.NW_TRACKER_TEST_DB?.trim()) {
    return null;
  }
  const row = db
    .prepare(`SELECT id FROM accounts WHERE import_key = ?`)
    .get(VITEST_SANTANDER_CC_MASTER_NOTES) as { id: number } | undefined;
  return row?.id ?? null;
}

/**
 * Remove every data row tests accumulated on the fixture master (statements, ledger,
 * valuations, category rules). Call from `afterAll` in any file that writes to it —
 * leftover fixture data leaks into group totals and category lookups on later runs.
 */
export function wipeVitestCcFixtureData(importKey: string = VITEST_SANTANDER_CC_MASTER_NOTES): void {
  const account = db
    .prepare(`SELECT id FROM accounts WHERE import_key = ?`)
    .get(importKey) as { id: number } | undefined;
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
  db.prepare(`DELETE FROM cc_billing_month_metrics WHERE account_id = ?`).run(id);
  db.prepare(`DELETE FROM valuations WHERE account_id = ?`).run(id);
  // The owed walk's anchors (migration 259): left behind, they kept valuing the fixture card
  // after its valuations were wiped, and the group charts read it.
  db.prepare(`DELETE FROM cc_owed_anchors WHERE account_id = ?`).run(id);
  db.prepare(`DELETE FROM flow_categories WHERE account_id = ?`).run(id);
  db.prepare(`DELETE FROM flow_notes WHERE account_id = ?`).run(id);
}

/** Isolated US-issuer card master (synthetic last4, USD only). */
export const VITEST_LONESTAR_CC_MASTER_NOTES = "credit_card_master|lonestar|vitest-fixture";
export const VITEST_LONESTAR_CARD_LAST4 = "4876";

/** Idempotent: one Lonestar (fictional US issuer) card master for the USD-only statement tests. */
export function ensureVitestLonestarFixture(): number {
  if (!process.env.NW_TRACKER_TEST_DB?.trim()) throw new Error("ensureVitestLonestarFixture: tests only");
  ensureVitestCreditCardFixtures();
  const existing = db.prepare(`SELECT id FROM accounts WHERE import_key = ?`).get(VITEST_LONESTAR_CC_MASTER_NOTES) as
    | { id: number }
    | undefined;
  if (existing) return existing.id;
  const bucket = db
    .prepare(`SELECT id FROM asset_groups WHERE slug IN ('credit_card', 'credit_cards__credit_card') LIMIT 1`)
    .get() as { id: number } | undefined;
  if (!bucket) throw new Error("Vitest DB seed failed: expected credit_card asset group (run migrations).");
  const id = Number(
    db
      .prepare(
        `INSERT INTO accounts (asset_group_id, name, notes, import_key)
         VALUES (?, 'Vitest · lonestar · fixture', ?, ?)`
      )
      .run(bucket.id, VITEST_LONESTAR_CC_MASTER_NOTES, VITEST_LONESTAR_CC_MASTER_NOTES).lastInsertRowid
  );
  db.prepare(
    `INSERT INTO credit_card_account_config (account_id, billing_cycle_start_day, billing_cycle_end_day, card_last4, issuer)
     VALUES (?, 1, 28, ?, 'lonestar')`
  ).run(id, VITEST_LONESTAR_CARD_LAST4);
  return id;
}
