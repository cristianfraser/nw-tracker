import { ccCardRegistry } from "./ccCardRegistry.js";
import { cardLast4ForCreditCardAccount } from "./ccManualBillingMonth.js";
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
    .prepare(`SELECT superseded_target_last4 FROM credit_card_account_config WHERE account_id = ?`)
    .get(accountId) as { superseded_target_last4: string | null } | undefined;
  const target = String(row?.superseded_target_last4 ?? "").trim();
  return target || null;
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

/**
 * Physical card last4s billed on one CC master (titular + distinct statement card_last4). The
 * titular is `credit_card_account_config.card_last4`, the card identity — a master without one
 * is a data problem and throws.
 */
export function associatedCardLast4sForMaster(masterId: number): string[] {
  const titular = cardLast4ForCreditCardAccount(masterId);
  if (!titular) {
    throw new Error(`Credit card master ${masterId} has no credit_card_account_config.card_last4`);
  }

  const statementRows = db
    .prepare(
      `SELECT DISTINCT card_last4 FROM cc_statements
       WHERE account_id = ? AND card_last4 IS NOT NULL AND TRIM(card_last4) != ''`
    )
    .all(masterId) as { card_last4: string }[];

  const last4s = new Set<string>([titular]);
  for (const { card_last4 } of statementRows) {
    const l4 = String(card_last4).trim();
    if (l4) last4s.add(l4);
  }

  return [...last4s].sort((a, b) => {
    if (a === titular && b !== titular) return -1;
    if (b === titular && a !== titular) return 1;
    return a.localeCompare(b);
  });
}

