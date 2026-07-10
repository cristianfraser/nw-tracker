import { recomputeCcBillingMonthBalances } from "./ccBillingBalances.js";
import { ccCardRegistry } from "./ccCardRegistry.js";
import { upsertCreditCardValuationsFromLedger } from "./ccCreditCardValuations.js";
import { db } from "./db.js";
import { resolveMasterAccountIdForCardLast4 } from "./creditCardTree.js";

/**
 * Cards whose statements/installments are tracked on the successor card.
 * PDF filenames may still contain the old last4; imports route to the target account.
 * Real card last4s live in gitignored `cfraser/cc-cards.json` (see ccCardRegistry).
 */
export const SANTANDER_CC_IMPORT_REDIRECT_LAST4: Readonly<Record<string, string>> =
  ccCardRegistry().import_redirect_last4;

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

const SUPERSEDED_SANTANDER_MASTER_NOTES = new Set(ccCardRegistry().superseded_master_notes);

export function isSupersededSantanderCcMaster(accountId: number): boolean {
  if (supersededCcTargetLast4(accountId) != null) return true;

  const row = db
    .prepare(`SELECT import_key, exclude_from_group_totals FROM accounts WHERE id = ?`)
    .get(accountId) as { import_key: string | null; exclude_from_group_totals: number } | undefined;
  if (!row) return false;
  const importKey = String(row.import_key ?? "").trim();
  if (!SUPERSEDED_SANTANDER_MASTER_NOTES.has(importKey)) return false;
  if (row.exclude_from_group_totals !== 1) return false;
  const last4 = importKey.slice(importKey.lastIndexOf("|") + 1);
  const targetLast4 = SANTANDER_CC_IMPORT_REDIRECT_LAST4[last4];
  return targetLast4 != null && resolveMasterAccountIdForCardLast4(targetLast4) != null;
}

/** Physical card last4s billed on one CC master (titular + distinct statement card_last4). */
export function associatedCardLast4sForMaster(masterId: number): string[] {
  const row = db
    .prepare(`SELECT notes FROM accounts WHERE id = ?`)
    .get(masterId) as { notes: string | null } | undefined;
  const notes = String(row?.notes ?? "").trim();
  const titularMatch = /^credit_card_master\|[^|]+\|(\d{4})$/.exec(notes);
  const titular = titularMatch?.[1] ?? null;

  const statementRows = db
    .prepare(
      `SELECT DISTINCT card_last4 FROM cc_statements
       WHERE account_id = ? AND card_last4 IS NOT NULL AND TRIM(card_last4) != ''`
    )
    .all(masterId) as { card_last4: string }[];

  const last4s = new Set<string>();
  if (titular) last4s.add(titular);
  for (const { card_last4 } of statementRows) {
    const l4 = String(card_last4).trim();
    if (l4) last4s.add(l4);
  }

  return [...last4s].sort((a, b) => {
    if (titular != null) {
      if (a === titular && b !== titular) return -1;
      if (b === titular && a !== titular) return 1;
    }
    return a.localeCompare(b);
  });
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
