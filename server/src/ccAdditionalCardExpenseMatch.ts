import type { Database } from "better-sqlite3";
import { db } from "./db.js";
import {
  NO_CUENTA_CC_EXPENSE_SLUG,
  getCcExpenseCategoryBySlug,
  resolveCcExpensePurchaseKey,
} from "./ccExpenseCategories.js";
import {
  getCcExpensePurchaseNote,
  setCcExpensePurchaseNote,
} from "./ccExpensePurchaseNotes.js";

export const AUTO_ADDITIONAL_CARD_NOTE_PREFIX = "auto:additional-card";

export function isAdditionalCardExpenseLine(
  originCardLast4: string | null | undefined,
  primaryCardLast4: string | null | undefined
): boolean {
  const origin = String(originCardLast4 ?? "").trim();
  const primary = String(primaryCardLast4 ?? "").trim();
  if (!origin || !primary) return false;
  return origin !== primary;
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

  if (!isAdditionalCardExpenseLine(origin, primary)) {
    return { applied: false, skippedUserCleared: false, notesUpdated: false, purchaseKey };
  }

  if (opts.skipIfUserCleared !== false && userClearedUniquePurchase(opts.accountId, purchaseKey, dbHandle)) {
    return { applied: false, skippedUserCleared: true, notesUpdated: false, purchaseKey };
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

  return { applied: true, skippedUserCleared: false, notesUpdated, purchaseKey };
}
