import { deleteFlowCategory, getFlowCategory, putFlowCategory } from "./flows/flowCategories.js";
import { deleteFlowNote, getFlowNote, setFlowNote } from "./flows/flowNotes.js";
import type { Database } from "better-sqlite3";
import { checkingCartolaStablePurchaseKey } from "./checkingCartolaParse.js";
import { db } from "./db.js";
import { buildExpenseKey, type CheckingPortion } from "./expenseKeys.js";
import { moveBillLink } from "./flows/flowLinks.js";

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
  putFlowCategory(accountId, purchaseKey, categoryId, "coalesce", dbHandle);
}

function migratePurchaseNotesKey(
  accountId: number,
  legacyKey: string,
  stableKey: string,
  dbHandle: Database
): void {
  const notes = getFlowNote(accountId, legacyKey, dbHandle);
  if (!notes?.trim()) return;
  setFlowNote(accountId, stableKey, notes, dbHandle);
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
    moveBillLink(fromKey, toKey, dbHandle);
    const row = getFlowCategory(accountId, fromKey, dbHandle);
    const notes = getFlowNote(accountId, fromKey, dbHandle);
    if (!row && !notes?.trim()) continue;
    if (row) {
      upsertUniquePurchaseCategory(accountId, toKey, row.category_id, dbHandle);
    }
    migratePurchaseNotesKey(accountId, fromKey, toKey, dbHandle);
    deleteFlowCategory(accountId, fromKey, dbHandle);
    deleteFlowNote(accountId, fromKey, dbHandle);
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
    const row = getFlowCategory(accountId, legacyKey, dbHandle);
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
