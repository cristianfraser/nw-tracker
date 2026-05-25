import { recomputeCcBillingMonthBalances } from "./ccBillingBalances.js";
import { upsertCreditCardValuationsFromLedger } from "./ccInstallmentLedgerDb.js";
import { db } from "./db.js";
import { resolveMasterAccountIdForCardLast4 } from "./creditCardTree.js";

/**
 * Santander cards whose statements/installments are tracked on the successor card.
 * PDF filenames may still contain the old last4; imports route to the target account.
 *
 * Note: 4141 and 4242 are sequential cards (minimal overlap at switchover), not consolidation.
 */
export const SANTANDER_CC_IMPORT_REDIRECT_LAST4: Readonly<Record<string, string>> = {
  "4111": "4242",
  "4112": "4242",
};

export function normalizeCcImportCardLast4(last4: string): string {
  const l4 = String(last4 ?? "").trim();
  if (!l4) return l4;
  return SANTANDER_CC_IMPORT_REDIRECT_LAST4[l4] ?? l4;
}

/** Resolve master account for PDF/CSV import (applies consolidation redirects). */
export function resolveMasterAccountIdForImportCardLast4(last4: string): number | null {
  return resolveMasterAccountIdForCardLast4(normalizeCcImportCardLast4(last4));
}

export function supersededCcTargetLast4(accountId: number): string | null {
  const row = db
    .prepare(`SELECT notes FROM credit_card_account_config WHERE account_id = ?`)
    .get(accountId) as { notes: string | null } | undefined;
  const notes = String(row?.notes ?? "").trim();
  const m = /^superseded:(\d{4})$/.exec(notes);
  return m?.[1] ?? null;
}

export function isSupersededSantanderCcMaster(accountId: number): boolean {
  return supersededCcTargetLast4(accountId) != null;
}

/** Remove imported CC statements, ledger, and billing rows for one master account. */
export function purgeCcImportedDataForAccount(accountId: number): {
  statements: number;
  purchases: number;
  billing: number;
  valuations_cleared: number;
} {
  let statements = 0;
  let purchases = 0;
  let billing = 0;
  let valuations_cleared = 0;

  const tx = db.transaction(() => {
    db.prepare(
      `DELETE FROM cc_installment_payments
       WHERE purchase_id IN (SELECT id FROM cc_installment_purchases WHERE account_id = ?)`
    ).run(accountId);
    purchases = db.prepare(`DELETE FROM cc_installment_purchases WHERE account_id = ?`).run(accountId)
      .changes;
    statements = db.prepare(`DELETE FROM cc_statements WHERE account_id = ?`).run(accountId).changes;
    billing = db
      .prepare(`DELETE FROM cc_billing_month_balances WHERE account_id = ?`)
      .run(accountId).changes;
    valuations_cleared = db.prepare(`DELETE FROM valuations WHERE account_id = ?`).run(accountId).changes;
    const viewIds = db
      .prepare(`SELECT id FROM accounts WHERE source_account_id = ? AND account_kind = 'liability_view'`)
      .all(accountId) as { id: number }[];
    for (const { id } of viewIds) {
      valuations_cleared += db.prepare(`DELETE FROM valuations WHERE account_id = ?`).run(id).changes;
    }
  });
  tx();

  upsertCreditCardValuationsFromLedger(accountId);
  recomputeCcBillingMonthBalances(accountId);

  return { statements, purchases, billing, valuations_cleared };
}

export function markSantanderCcSuperseded(last4: string, targetLast4: string): void {
  const master = resolveMasterAccountIdForCardLast4(last4);
  if (master == null) return;
  db.prepare(`UPDATE credit_card_account_config SET notes = ? WHERE account_id = ?`).run(
    `superseded:${targetLast4}`,
    master
  );
  db.prepare(`UPDATE accounts SET exclude_from_group_totals = 1 WHERE id = ?`).run(master);
  const views = db
    .prepare(`SELECT id FROM accounts WHERE source_account_id = ? AND account_kind = 'liability_view'`)
    .all(master) as { id: number }[];
  for (const { id } of views) {
    db.prepare(`UPDATE accounts SET exclude_from_group_totals = 1 WHERE id = ?`).run(id);
  }
}

export function unmarkSantanderCcSuperseded(last4: string): void {
  const master = resolveMasterAccountIdForCardLast4(last4);
  if (master == null) return;
  db.prepare(`UPDATE credit_card_account_config SET notes = NULL WHERE account_id = ?`).run(master);
  db.prepare(`UPDATE accounts SET exclude_from_group_totals = 0 WHERE id = ?`).run(master);
  const views = db
    .prepare(`SELECT id FROM accounts WHERE source_account_id = ? AND account_kind = 'liability_view'`)
    .all(master) as { id: number }[];
  for (const { id } of views) {
    db.prepare(`UPDATE accounts SET exclude_from_group_totals = 0 WHERE id = ?`).run(id);
  }
}

function is4141CardRow(row: { card_last4: string | null; source_pdf: string | null }): boolean {
  const l4 = String(row.card_last4 ?? "").trim();
  if (l4 === "4141") return true;
  return /(?:tarjeta|cuenta)\s*(?:usd\s*)?4141/i.test(String(row.source_pdf ?? ""));
}

/** Move 4141 PDF data off the 4242 master back onto the 4141 master (sequential cards, not duplicates). */
export function repairCc4141And4242Split(): {
  statements_moved: number;
  purchases_moved: number;
  purchases_deduped: number;
  valuations_rebuilt: { account_4141: number; account_4242: number };
} {
  const id4141 = resolveMasterAccountIdForCardLast4("4141");
  const id4242 = resolveMasterAccountIdForCardLast4("4242");
  if (id4141 == null || id4242 == null) {
    throw new Error("4141 and 4242 master accounts must exist");
  }

  let statements_moved = 0;
  let purchases_moved = 0;
  let purchases_deduped = 0;

  const tx = db.transaction(() => {
    unmarkSantanderCcSuperseded("4141");

    const stmtRows = db
      .prepare(
        `SELECT id, card_last4, source_pdf FROM cc_statements WHERE account_id = ?`
      )
      .all(id4242) as { id: number; card_last4: string | null; source_pdf: string | null }[];

    for (const row of stmtRows) {
      if (!is4141CardRow(row)) continue;
      statements_moved += db
        .prepare(`UPDATE cc_statements SET account_id = ? WHERE id = ?`)
        .run(id4141, row.id).changes;
    }

    const purchaseRows = db
      .prepare(
        `SELECT id, card_group, canonical_row_id, source_pdf_sample
         FROM cc_installment_purchases WHERE account_id = ?`
      )
      .all(id4242) as {
      id: number;
      card_group: string;
      canonical_row_id: string;
      source_pdf_sample: string | null;
    }[];

    for (const row of purchaseRows) {
      if (!is4141CardRow({ card_last4: null, source_pdf: row.source_pdf_sample })) continue;
      const existing = db
        .prepare(
          `SELECT id FROM cc_installment_purchases
           WHERE account_id = ? AND card_group = ? AND canonical_row_id = ?`
        )
        .get(id4141, row.card_group, row.canonical_row_id) as { id: number } | undefined;
      if (existing) {
        db.prepare(`DELETE FROM cc_installment_payments WHERE purchase_id = ?`).run(row.id);
        purchases_deduped += db.prepare(`DELETE FROM cc_installment_purchases WHERE id = ?`).run(row.id).changes;
        continue;
      }
      purchases_moved += db
        .prepare(`UPDATE cc_installment_purchases SET account_id = ? WHERE id = ?`)
        .run(id4141, row.id).changes;
    }

    db.prepare(`DELETE FROM valuations WHERE account_id = ?`).run(id4141);
    db.prepare(`DELETE FROM valuations WHERE account_id = ?`).run(id4242);
    for (const { id } of db
      .prepare(
        `SELECT id FROM accounts WHERE source_account_id IN (?, ?) AND account_kind = 'liability_view'`
      )
      .all(id4141, id4242) as { id: number }[]) {
      db.prepare(`DELETE FROM valuations WHERE account_id = ?`).run(id);
    }
  });
  tx();

  const valuations_rebuilt = {
    account_4141: upsertCreditCardValuationsFromLedger(id4141),
    account_4242: upsertCreditCardValuationsFromLedger(id4242),
  };
  recomputeCcBillingMonthBalances(id4141);
  recomputeCcBillingMonthBalances(id4242);

  return { statements_moved, purchases_moved, purchases_deduped, valuations_rebuilt };
}
