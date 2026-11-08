import type { Database } from "better-sqlite3";
import { checkingCartolaStablePurchaseKey } from "./checkingCartolaParse.js";
import { db } from "./db.js";
import { buildExpenseKey, type CheckingPortion } from "./expenseKeys.js";

/** Key of a checking movement with no cartola identity (a daily row, a mail-built row). */
export function checkingMovementPurchaseKey(movementId: number, portion: CheckingPortion = "gastos"): string {
  return buildExpenseKey({ kind: "checking_mv", movementId, portion });
}

function upsertUniquePurchaseCategory(
  accountId: number,
  purchaseKey: string,
  categoryId: number | null,
  dbHandle: Database
): void {
  dbHandle
    .prepare(
      `INSERT INTO cc_expense_unique_purchases (account_id, purchase_key, category_id)
       VALUES (?, ?, ?)
       ON CONFLICT(account_id, purchase_key) DO UPDATE SET
         category_id = COALESCE(excluded.category_id, cc_expense_unique_purchases.category_id)`
    )
    .run(accountId, purchaseKey, categoryId);
}

function migratePurchaseNotesKey(
  accountId: number,
  legacyKey: string,
  stableKey: string,
  dbHandle: Database
): void {
  const row = dbHandle
    .prepare(
      `SELECT notes FROM cc_expense_purchase_notes
       WHERE account_id = ? AND purchase_key = ?`
    )
    .get(accountId, legacyKey) as { notes: string } | undefined;
  if (!row?.notes?.trim()) return;
  dbHandle
    .prepare(
      `INSERT INTO cc_expense_purchase_notes (account_id, purchase_key, notes, updated_at)
       VALUES (?, ?, ?, datetime('now'))
       ON CONFLICT(account_id, purchase_key) DO UPDATE SET
         notes = excluded.notes,
         updated_at = excluded.updated_at`
    )
    .run(accountId, stableKey, row.notes);
}

/**
 * Moves the place bill linked to a daily row (`checking-mv:{id}`) onto the cartola row's stable key,
 * with its rejections. A target already linked to another bill throws: two bills cannot claim one
 * payment, and dropping either would lose a pairing silently.
 */
function moveRealEstateLinkKey(fromKey: string, toKey: string, dbHandle: Database): void {
  dbHandle
    .prepare(`UPDATE OR IGNORE real_estate_expense_link_rejections SET purchase_key = ? WHERE purchase_key = ?`)
    .run(toKey, fromKey);
  const from = dbHandle
    .prepare(`SELECT expense_entry_id FROM real_estate_expense_links WHERE purchase_key = ?`)
    .get(fromKey) as { expense_entry_id: number } | undefined;
  if (!from) return;
  const to = dbHandle
    .prepare(`SELECT expense_entry_id FROM real_estate_expense_links WHERE purchase_key = ?`)
    .get(toKey) as { expense_entry_id: number } | undefined;
  if (to) {
    throw new Error(
      `real-estate bills ${from.expense_entry_id} and ${to.expense_entry_id} both claim the payment ${fromKey} → ${toKey}`
    );
  }
  dbHandle.prepare(`UPDATE real_estate_expense_links SET purchase_key = ? WHERE purchase_key = ?`).run(toKey, fromKey);
}

/** Copy Único category + notes from `checking-mv:{id}` to stable cartola note key; move its bill link. */
export function transferCheckingGastosCategoryFromMovementToNote(
  accountId: number,
  fromMovementId: number,
  toCartolaNote: string,
  dbHandle: Database = db
): number {
  let migrated = 0;
  for (const portion of ["gastos", "deposit"] as const) {
    const fromKey = checkingMovementPurchaseKey(fromMovementId, portion);
    const toKey = checkingCartolaStablePurchaseKey(accountId, toCartolaNote, portion);
    if (!toKey) continue;
    moveRealEstateLinkKey(fromKey, toKey, dbHandle);
    const row = dbHandle
      .prepare(
        `SELECT category_id FROM cc_expense_unique_purchases
         WHERE account_id = ? AND purchase_key = ?`
      )
      .get(accountId, fromKey) as { category_id: number | null } | undefined;
    const notesRow = dbHandle
      .prepare(
        `SELECT notes FROM cc_expense_purchase_notes
         WHERE account_id = ? AND purchase_key = ?`
      )
      .get(accountId, fromKey) as { notes: string } | undefined;
    if (!row && !notesRow?.notes?.trim()) continue;
    if (row) {
      upsertUniquePurchaseCategory(accountId, toKey, row.category_id, dbHandle);
    }
    migratePurchaseNotesKey(accountId, fromKey, toKey, dbHandle);
    dbHandle
      .prepare(
        `DELETE FROM cc_expense_unique_purchases WHERE account_id = ? AND purchase_key = ?`
      )
      .run(accountId, fromKey);
    dbHandle
      .prepare(`DELETE FROM cc_expense_purchase_notes WHERE account_id = ? AND purchase_key = ?`)
      .run(accountId, fromKey);
    migrated += 1;
  }
  return migrated;
}

/** Copy Único category from legacy `checking-mv:{id}` to stable cartola note key. */
export function migrateCheckingGastosCategoryToStableKey(
  accountId: number,
  movementId: number,
  note: string | null | undefined,
  dbHandle: Database = db
): number {
  let migrated = 0;
  for (const portion of ["gastos", "deposit"] as const) {
    const legacyKey = checkingMovementPurchaseKey(movementId, portion);
    const stableKey = checkingCartolaStablePurchaseKey(accountId, note, portion);
    if (!stableKey || stableKey === legacyKey) continue;
    const row = dbHandle
      .prepare(
        `SELECT category_id FROM cc_expense_unique_purchases
         WHERE account_id = ? AND purchase_key = ?`
      )
      .get(accountId, legacyKey) as { category_id: number | null } | undefined;
    if (!row) continue;
    upsertUniquePurchaseCategory(accountId, stableKey, row.category_id, dbHandle);
    migratePurchaseNotesKey(accountId, legacyKey, stableKey, dbHandle);
    migrated += 1;
  }
  return migrated;
}

/** Before deleting cartola movements, persist Único categories on stable keys. */
export function preserveCheckingGastosCategoriesForCartolaNotes(
  accountId: number,
  notePrefix: string,
  dbHandle: Database = db
): number {
  const rows = dbHandle
    .prepare(
      `SELECT id, note FROM movements
       WHERE account_id = ? AND note LIKE ?`
    )
    .all(accountId, notePrefix) as { id: number; note: string | null }[];
  let migrated = 0;
  for (const row of rows) {
    migrated += migrateCheckingGastosCategoryToStableKey(accountId, row.id, row.note, dbHandle);
  }
  return migrated;
}
