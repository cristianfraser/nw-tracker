import { getFlowCategory, putFlowCategory } from "./flows/flowCategories.js";
import { deleteFlowNote, getFlowNote, setFlowNote, updateFlowNote } from "./flows/flowNotes.js";
import type { Database } from "better-sqlite3";
import { expenseKeyKind, isInstallmentContractKind } from "./expenseKeys.js";
import { ccCardRegistry } from "./ccCardRegistry.js";
import { db } from "./db.js";
import { latestStatementOriginPlastics } from "./cards/purchases.js";
import {
  ADDITIONAL_CARD_CC_EXPENSE_SLUG,
  getCcExpenseCategoryBySlug,
  loadCcStatementLineExpenseCtx,
  resolveCcExpensePurchaseKey,
} from "./ccExpenseCategories.js";
import {
  getCcExpensePurchaseNote,
  setCcExpensePurchaseNote,
} from "./ccExpensePurchaseNotes.js";

export const AUTO_ADDITIONAL_CARD_NOTE_PREFIX = "auto:additional-card";

/** User chose Sin clasificar — do not re-apply the adicional-card auto category on reload. */
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
  return isUserDeclinedAutoCategoryNote(getFlowNote(accountId, purchaseKey, dbHandle) ?? "");
}

export function markUserDeclinedAutoCategory(
  accountId: number,
  purchaseKey: string,
  dbHandle: Database = db
): void {
  const existing = getFlowNote(accountId, purchaseKey, dbHandle);
  const merged = mergeUserDeclinedAutoCategoryNote(existing ?? "");
  setFlowNote(accountId, purchaseKey, merged, dbHandle);
}

export function clearUserDeclinedAutoCategory(
  accountId: number,
  purchaseKey: string,
  dbHandle: Database = db
): void {
  const existing = getFlowNote(accountId, purchaseKey, dbHandle);
  const stripped = stripUserDeclinedAutoCategoryNote(existing ?? "");
  if (!stripped) {
    deleteFlowNote(accountId, purchaseKey, dbHandle);
    return;
  }
  updateFlowNote(accountId, purchaseKey, stripped, dbHandle);
}

export function isInstallmentContractPurchaseKey(purchaseKey: string): boolean {
  return isInstallmentContractKind(expenseKeyKind(purchaseKey));
}

/**
 * Additional-cardholder purchase: the origin card is in the registry's
 * `additional_card_last4s` list. A bare origin ≠ statement-card mismatch is NOT
 * enough — the user's own predecessor/successor plastics show up as foreign
 * origins on transition-month statements (e.g. the 0901 successor charging while
 * statements were still 0781-branded) and those are the user's own gastos.
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

/**
 * The additional cardholder's card currently in use on a card account: the additional origin of
 * the account's latest statement that printed one (web-paste buckets left out — their origin is
 * this function's own answer). A listing that only says «additional» (the Santander feed) is
 * stored under it; a new plastic takes over once its first statement prints it, and the statement
 * then replaces the bucket's lines anyway. Throws when the account has none on record or two
 * share the latest statement: an «additional» line must never be stored as the holder's own.
 */
export function activeAdditionalCardLast4ForAccount(
  accountId: number,
  additionalCardLast4s: readonly string[] = ccCardRegistry().additional_card_last4s,
  dbHandle: Database = db
): string {
  if (additionalCardLast4s.length === 0) {
    throw new Error(`Card account ${accountId}: a line is marked additional, but no additional card is configured`);
  }
  const origins = latestStatementOriginPlastics(accountId, additionalCardLast4s, dbHandle);
  if (origins.length !== 1) {
    throw new Error(
      origins.length === 0
        ? `Card account ${accountId}: a line is marked additional, but no statement of this account prints an additional card`
        : `Card account ${accountId}: its latest statement prints several additional cards (${origins.join(", ")})`
    );
  }
  return origins[0]!;
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

export type ApplyAdditionalCardNoCuentaResult = {
  applied: boolean;
  skippedUserCleared: boolean;
  /** Unique purchase already has a category (user or prior auto) — never overwrite. */
  skippedExistingCategory: boolean;
  /** User cleared to Sin clasificar — do not re-apply the auto category (one-shot only). */
  skippedUserDeclinedAuto: boolean;
  /** Installment contracts — the adicional auto category never applies; use line-level cuota rules. */
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

  const existingUnique = getFlowCategory(opts.accountId, purchaseKey, dbHandle);

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

  const additionalCard = getCcExpenseCategoryBySlug(ADDITIONAL_CARD_CC_EXPENSE_SLUG);
  if (!additionalCard) {
    throw new Error("additional_card expense category missing; run migrations first");
  }

  putFlowCategory(opts.accountId, purchaseKey, additionalCard.id, "replace", dbHandle);

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
