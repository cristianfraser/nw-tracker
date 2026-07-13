import type { Database } from "better-sqlite3";
import { ccCardRegistry } from "./ccCardRegistry.js";
import { db } from "./db.js";
import {
  NO_CUENTA_CC_EXPENSE_SLUG,
  getCcExpenseCategoryBySlug,
  loadCcStatementLineExpenseCtx,
  resolveCcExpensePurchaseKey,
} from "./ccExpenseCategories.js";
import {
  getCcExpensePurchaseNote,
  setCcExpensePurchaseNote,
} from "./ccExpensePurchaseNotes.js";

export const AUTO_ADDITIONAL_CARD_NOTE_PREFIX = "auto:additional-card";

/** User chose Sin clasificar — do not re-apply adicional-card / auto no_cuenta on reload. */
export const USER_DECLINED_AUTO_CATEGORY_PREFIX = "auto:user-declined-auto-category";

export function isUserDeclinedAutoCategoryNote(note: string): boolean {
  return String(note ?? "")
    .split("\n")
    .some((line) => line.trim() === USER_DECLINED_AUTO_CATEGORY_PREFIX);
}

export function mergeUserDeclinedAutoCategoryNote(existingDbNote: string): string {
  const existing = String(existingDbNote ?? "").trim();
  if (isUserDeclinedAutoCategoryNote(existing)) return existing;
  if (!existing) return USER_DECLINED_AUTO_CATEGORY_PREFIX;
  return `${USER_DECLINED_AUTO_CATEGORY_PREFIX}\n\n${existing}`;
}

export function stripUserDeclinedAutoCategoryNote(note: string): string {
  const lines = String(note ?? "").split("\n");
  const kept = lines.filter((line) => line.trim() !== USER_DECLINED_AUTO_CATEGORY_PREFIX);
  return kept.join("\n").trim();
}

export function userDeclinedAutoCategoryForPurchase(
  accountId: number,
  purchaseKey: string,
  dbHandle: Database = db
): boolean {
  const row = dbHandle
    .prepare(
      `SELECT notes FROM cc_expense_purchase_notes WHERE account_id = ? AND purchase_key = ?`
    )
    .get(accountId, purchaseKey) as { notes: string } | undefined;
  return isUserDeclinedAutoCategoryNote(row?.notes ?? "");
}

export function markUserDeclinedAutoCategory(
  accountId: number,
  purchaseKey: string,
  dbHandle: Database = db
): void {
  const existing = (
    dbHandle
      .prepare(
        `SELECT notes FROM cc_expense_purchase_notes WHERE account_id = ? AND purchase_key = ?`
      )
      .get(accountId, purchaseKey) as { notes: string } | undefined
  )?.notes;
  const merged = mergeUserDeclinedAutoCategoryNote(existing ?? "");
  dbHandle
    .prepare(
      `INSERT INTO cc_expense_purchase_notes (account_id, purchase_key, notes, updated_at)
       VALUES (?, ?, ?, datetime('now'))
       ON CONFLICT(account_id, purchase_key) DO UPDATE SET
         notes = excluded.notes,
         updated_at = excluded.updated_at`
    )
    .run(accountId, purchaseKey, merged);
}

export function clearUserDeclinedAutoCategory(
  accountId: number,
  purchaseKey: string,
  dbHandle: Database = db
): void {
  const existing = (
    dbHandle
      .prepare(
        `SELECT notes FROM cc_expense_purchase_notes WHERE account_id = ? AND purchase_key = ?`
      )
      .get(accountId, purchaseKey) as { notes: string } | undefined
  )?.notes;
  const stripped = stripUserDeclinedAutoCategoryNote(existing ?? "");
  if (!stripped) {
    dbHandle
      .prepare(`DELETE FROM cc_expense_purchase_notes WHERE account_id = ? AND purchase_key = ?`)
      .run(accountId, purchaseKey);
    return;
  }
  dbHandle
    .prepare(
      `UPDATE cc_expense_purchase_notes SET notes = ?, updated_at = datetime('now')
       WHERE account_id = ? AND purchase_key = ?`
    )
    .run(stripped, accountId, purchaseKey);
}

export function isInstallmentContractPurchaseKey(purchaseKey: string): boolean {
  return (
    purchaseKey.startsWith("installment-h:") ||
    purchaseKey.startsWith("installment-pr:") ||
    purchaseKey.startsWith("installment:")
  );
}

/**
 * Additional-cardholder purchase: the origin card is in the registry's
 * `additional_card_last4s` list. A bare origin ≠ statement-card mismatch is NOT
 * enough — the user's own predecessor/successor plastics show up as foreign
 * origins on transition-month statements (e.g. the 9011 successor charging while
 * statements were still 7817-branded) and those are the user's own gastos.
 */
export function isAdditionalCardExpenseLine(
  originCardLast4: string | null | undefined,
  primaryCardLast4: string | null | undefined,
  additionalCardLast4s: readonly string[] = ccCardRegistry().additional_card_last4s
): boolean {
  const origin = String(originCardLast4 ?? "").trim();
  const primary = String(primaryCardLast4 ?? "").trim();
  if (!origin || !primary) return false;
  if (origin === primary) return false;
  return additionalCardLast4s.includes(origin);
}

export function formatAutoAdditionalCardNote(opts: {
  originLast4: string;
  primaryLast4: string;
}): string {
  return `${AUTO_ADDITIONAL_CARD_NOTE_PREFIX}|origin:${opts.originLast4}|stmt:${opts.primaryLast4}`;
}

export function isAutoAdditionalCardPurchaseNote(note: string): boolean {
  return String(note ?? "").trimStart().startsWith(AUTO_ADDITIONAL_CARD_NOTE_PREFIX);
}

function extractUserNoteSuffix(note: string): string {
  const lines = note.split("\n");
  const first = lines[0]?.trim() ?? "";
  if (!isAutoAdditionalCardPurchaseNote(first)) return note.trim();
  const rest = lines.slice(1).join("\n").trim();
  return rest.replace(/^\n+/, "").trim();
}

/** Replace stale auto line; preserve user suffix after blank line. */
export function mergeAutoAdditionalCardNote(
  existingDbNote: string,
  autoNote: string
): string {
  const auto = String(autoNote ?? "").trim();
  if (!auto) return String(existingDbNote ?? "").trim();

  const existing = String(existingDbNote ?? "").trim();
  if (!existing) return auto;
  if (isAutoAdditionalCardPurchaseNote(existing)) {
    const suffix = extractUserNoteSuffix(existing);
    return suffix ? `${auto}\n\n${suffix}` : auto;
  }
  return `${auto}\n\n${existing}`;
}

export function userClearedUniquePurchase(
  accountId: number,
  purchaseKey: string,
  dbHandle: Database = db
): boolean {
  const row = dbHandle
    .prepare(
      `SELECT category_id FROM cc_expense_unique_purchases
       WHERE account_id = ? AND purchase_key = ?`
    )
    .get(accountId, purchaseKey) as { category_id: number | null } | undefined;
  return row != null && row.category_id == null;
}

export type ApplyAdditionalCardNoCuentaResult = {
  applied: boolean;
  skippedUserCleared: boolean;
  /** Unique purchase already has a category (user or prior auto) — never overwrite. */
  skippedExistingCategory: boolean;
  /** User cleared to Sin clasificar — do not re-apply auto no_cuenta (one-shot only). */
  skippedUserDeclinedAuto: boolean;
  /** Installment contracts — adicional no_cuenta never applies; use line-level cuota rules. */
  skippedInstallment: boolean;
  notesUpdated: boolean;
  purchaseKey: string;
};

export function applyAdditionalCardNoCuentaForLine(opts: {
  accountId: number;
  statementLineId: number;
  originCardLast4: string | null | undefined;
  primaryCardLast4: string | null | undefined;
  skipIfUserCleared?: boolean;
  dbHandle?: Database;
}): ApplyAdditionalCardNoCuentaResult {
  const dbHandle = opts.dbHandle ?? db;
  const origin = String(opts.originCardLast4 ?? "").trim();
  const primary = String(opts.primaryCardLast4 ?? "").trim();
  const purchaseKey = resolveCcExpensePurchaseKey(opts.statementLineId);

  const lineCtx = loadCcStatementLineExpenseCtx(opts.statementLineId);
  if (lineCtx?.installment_flag === 1 || isInstallmentContractPurchaseKey(purchaseKey)) {
    return {
      applied: false,
      skippedUserCleared: false,
      skippedExistingCategory: false,
      skippedUserDeclinedAuto: false,
      skippedInstallment: true,
      notesUpdated: false,
      purchaseKey,
    };
  }

  if (!isAdditionalCardExpenseLine(origin, primary)) {
    return {
      applied: false,
      skippedUserCleared: false,
      skippedExistingCategory: false,
      skippedUserDeclinedAuto: false,
      skippedInstallment: false,
      notesUpdated: false,
      purchaseKey,
    };
  }

  if (userDeclinedAutoCategoryForPurchase(opts.accountId, purchaseKey, dbHandle)) {
    return {
      applied: false,
      skippedUserCleared: false,
      skippedExistingCategory: false,
      skippedUserDeclinedAuto: true,
      skippedInstallment: false,
      notesUpdated: false,
      purchaseKey,
    };
  }

  const existingUnique = dbHandle
    .prepare(
      `SELECT category_id FROM cc_expense_unique_purchases
       WHERE account_id = ? AND purchase_key = ?`
    )
    .get(opts.accountId, purchaseKey) as { category_id: number | null } | undefined;

  if (existingUnique != null) {
    if (existingUnique.category_id == null) {
      if (opts.skipIfUserCleared !== false) {
        return {
          applied: false,
          skippedUserCleared: true,
          skippedExistingCategory: false,
          skippedUserDeclinedAuto: false,
          skippedInstallment: false,
          notesUpdated: false,
          purchaseKey,
        };
      }
    } else {
      const autoNote = formatAutoAdditionalCardNote({ originLast4: origin, primaryLast4: primary });
      const existingNote = getCcExpensePurchaseNote(opts.accountId, purchaseKey);
      const merged = mergeAutoAdditionalCardNote(existingNote, autoNote);
      let notesUpdated = false;
      if (merged !== existingNote.trim()) {
        setCcExpensePurchaseNote({
          accountId: opts.accountId,
          purchaseKey,
          notes: merged,
        });
        notesUpdated = true;
      }
      return {
        applied: false,
        skippedUserCleared: false,
        skippedExistingCategory: true,
        skippedUserDeclinedAuto: false,
        skippedInstallment: false,
        notesUpdated,
        purchaseKey,
      };
    }
  }

  const noCuenta = getCcExpenseCategoryBySlug(NO_CUENTA_CC_EXPENSE_SLUG);
  if (!noCuenta) {
    throw new Error("no_cuenta expense category missing; run migrations first");
  }

  dbHandle
    .prepare(
      `INSERT INTO cc_expense_unique_purchases (account_id, purchase_key, category_id)
       VALUES (?, ?, ?)
       ON CONFLICT(account_id, purchase_key) DO UPDATE SET category_id = excluded.category_id`
    )
    .run(opts.accountId, purchaseKey, noCuenta.id);

  const autoNote = formatAutoAdditionalCardNote({ originLast4: origin, primaryLast4: primary });
  const existing = getCcExpensePurchaseNote(opts.accountId, purchaseKey);
  const merged = mergeAutoAdditionalCardNote(existing, autoNote);
  let notesUpdated = false;
  if (merged !== existing.trim()) {
    setCcExpensePurchaseNote({
      accountId: opts.accountId,
      purchaseKey,
      notes: merged,
    });
    notesUpdated = true;
  }

  return {
    applied: true,
    skippedUserCleared: false,
    skippedExistingCategory: false,
    skippedUserDeclinedAuto: false,
    skippedInstallment: false,
    notesUpdated,
    purchaseKey,
  };
}
