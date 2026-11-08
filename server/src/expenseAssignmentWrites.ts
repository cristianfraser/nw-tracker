/**
 * The expense-assignment write funnel (docs/untangle-plan.md F11): a category set on an expense
 * line — a card line, a checking movement, a plan's line — goes through one executor, and every
 * write that can change an expense deposit link (a line import, a movement, a category, a manual
 * link) re-syncs the links here, after it. Reading the expense lines never writes: the sync used to
 * run inside the read pipeline (`flowsExpenses.ts`).
 */
import { db } from "./db.js";
import {
  ccExpenseLineCategoryTarget,
  ccPlanCategoryTarget,
  ccStatementLineBelongsToCreditCardGroup,
  getCcExpenseCategoryBySlug,
  normalizeCcExpenseMerchantKey,
  UNCLASSIFIED_CC_EXPENSE_SLUG,
  type ExpenseCategoryTargetFacts,
} from "./ccExpenseCategories.js";
import { clearUserDeclinedAutoCategory, markUserDeclinedAutoCategory } from "./ccAdditionalCardExpenseMatch.js";
import {
  checkingGastosMovementBelongs,
  checkingGastosMovementCategoryTarget,
  checkingGastosMovementPurchaseKey,
} from "./flowsCheckingGastos.js";
import { isCheckingExpenseRefund, setCheckingExpenseRefundCategory } from "./checkingExpenseRefunds.js";
import { cartolaDescriptionFromNote } from "./checkingDescriptionPredicates.js";
import { clearExpenseCategoryRule, setExpenseCategoryRule, type CategoryRuleLink } from "./expenseCategoryRules.js";
import { purchaseIdFromPlanGastosLineId } from "./ccInstallmentPlanGastosLines.js";
import { syncExpenseDepositLinksFromGastosLines } from "./expenseDepositLinks.js";
import { expenseLinesForDepositLinkSync } from "./flowsExpenses.js";
import { registerExpenseLinkSync, requestExpenseLinkSync } from "./expenseLinkSync.js";

// ---------------------------------------------------------------------------------------------
// Expense deposit links: synced after the writes that can change them
// ---------------------------------------------------------------------------------------------

/** Re-syncs the expense deposit links from the lines on file (churn-free: unchanged rows stay). */
export function syncExpenseLinksNow(): void {
  syncExpenseDepositLinksFromGastosLines(expenseLinesForDepositLinkSync());
}
registerExpenseLinkSync(syncExpenseLinksNow);

// ---------------------------------------------------------------------------------------------
// Category assignment
// ---------------------------------------------------------------------------------------------

/**
 * Where a category change lands, resolved by the line's own module: the purchase key it is filed
 * under, the sibling keys the same purchase carries (a checking movement's deposit portion), the
 * card lines whose own category row the change replaces, the merchant whose rule a comercio-wide
 * change writes, and the user-declined marker a card line keeps.
 */
export type ExpenseCategoryTarget = ExpenseCategoryTargetFacts;

export type ExpenseCategoryAssignment = {
  category_slug: string;
  unique: boolean;
  merchant_key: string;
  purchase_key: string;
};

type AssignOpts = {
  unique: boolean;
  categorySlug?: string | null;
  clearCategory?: boolean;
  /** «Específico»: the rule for the merchant + this link instead of the general one. */
  ruleLink?: CategoryRuleLink | null;
};

/** The one executor: «Único» row, merchant rule, line rows, declined marker. Throws on bad input. */
export function assignExpenseCategory(target: ExpenseCategoryTarget, opts: AssignOpts): ExpenseCategoryAssignment {
  const categorySlug = opts.categorySlug != null ? String(opts.categorySlug).trim() : "";
  const hasCategory = categorySlug.length > 0;
  const clearCategory = opts.clearCategory === true;
  const ruleLink = opts.ruleLink ?? null;
  if (hasCategory && categorySlug === UNCLASSIFIED_CC_EXPENSE_SLUG) {
    throw new Error("cannot assign unclassified category");
  }
  const { accountId, merchantKey, purchaseKey } = target;
  if (!opts.unique && hasCategory && !merchantKey) {
    throw new Error("merchant required for comercio-wide category");
  }
  let catId: number | null = null;
  let resolvedSlug = UNCLASSIFIED_CC_EXPENSE_SLUG;
  if (hasCategory) {
    const cat = getCcExpenseCategoryBySlug(categorySlug);
    if (!cat) throw new Error("unknown category");
    catId = cat.id;
    resolvedSlug = cat.slug;
  }
  const keys = [purchaseKey, ...target.siblingPurchaseKeys];
  const delLine = db.prepare(`DELETE FROM cc_expense_line_categories WHERE statement_line_id = ?`);
  const delUnique = db.prepare(`DELETE FROM cc_expense_unique_purchases WHERE account_id = ? AND purchase_key = ?`);
  const upsertUnique = db.prepare(
    `INSERT INTO cc_expense_unique_purchases (account_id, purchase_key, category_id)
     VALUES (?, ?, ?)
     ON CONFLICT(account_id, purchase_key) DO UPDATE SET category_id = excluded.category_id`
  );
  db.transaction(() => {
    for (const lineId of target.lineCategoryRowIds) delLine.run(lineId);
    if (clearCategory) {
      if (opts.unique) {
        for (const key of keys) upsertUnique.run(accountId, key, null);
      } else {
        for (const key of keys) delUnique.run(accountId, key);
        if (merchantKey) clearExpenseCategoryRule(merchantKey, ruleLink);
        if (target.marksDeclinedAuto) markUserDeclinedAutoCategory(accountId, purchaseKey);
      }
      return;
    }
    if (target.clearsDeclinedAuto) clearUserDeclinedAutoCategory(accountId, purchaseKey);
    for (const key of keys) delUnique.run(accountId, key);
    if (opts.unique) {
      upsertUnique.run(accountId, purchaseKey, catId);
    } else if (catId != null && merchantKey) {
      setExpenseCategoryRule(merchantKey, ruleLink, catId);
    }
  })();
  // A line's category decides whether it pairs with a deposit (`deposits`, internal transfers).
  requestExpenseLinkSync();
  return {
    category_slug: clearCategory ? UNCLASSIFIED_CC_EXPENSE_SLUG : resolvedSlug,
    unique: opts.unique,
    merchant_key: merchantKey,
    purchase_key: purchaseKey,
  };
}

export type FlowExpenseLineCategorySource = "cc" | "checking" | "manual" | "payslip";

/** A category change on an expense line of the Expenses page (`PATCH /api/flows/expenses/…/category`). */
export function assignFlowExpenseLineCategory(opts: AssignOpts & {
  lineId: number;
  /** Required when the same numeric id exists on cuenta corriente and tarjeta. */
  source?: FlowExpenseLineCategorySource;
}): ExpenseCategoryAssignment {
  if (opts.source === "manual") {
    throw new Error("manual expense entries are not editable");
  }
  if (opts.source === "payslip") {
    throw new Error("payslip deductions have a fixed category");
  }

  if (opts.lineId < 0) {
    const purchaseId = purchaseIdFromPlanGastosLineId(opts.lineId) ?? -opts.lineId;
    return assignExpenseCategory(ccPlanCategoryTarget(purchaseId), opts);
  }

  // A refund's category lives on the refund (`checkingExpenseRefunds.ts`); it is always its own.
  if (opts.source === "checking" && isCheckingExpenseRefund(opts.lineId)) {
    const slug = opts.clearCategory ? "unclassified" : (opts.categorySlug ?? "unclassified");
    setCheckingExpenseRefundCategory(opts.lineId, slug);
    requestExpenseLinkSync();
    const note = (db.prepare(`SELECT note FROM movements WHERE id = ?`).get(opts.lineId) as { note: string | null }).note;
    return {
      category_slug: slug,
      unique: true,
      merchant_key: normalizeCcExpenseMerchantKey(cartolaDescriptionFromNote(note)),
      purchase_key: checkingGastosMovementPurchaseKey(opts.lineId),
    };
  }

  const checking = checkingGastosMovementBelongs(opts.lineId);
  const cc = ccStatementLineBelongsToCreditCardGroup(opts.lineId);
  let source = opts.source;
  if (source == null) {
    if (checking.ok && cc.ok) throw new Error("ambiguous expense line id; pass source cc or checking");
    if (checking.ok) source = "checking";
    else if (cc.ok) source = "cc";
    else throw new Error("expense line not found");
  }
  if (source === "checking") {
    if (!checking.ok) throw new Error("checking gastos movement not found");
    return assignExpenseCategory(checkingGastosMovementCategoryTarget(opts.lineId), opts);
  }
  if (!cc.ok) throw new Error("statement line not in credit card group");
  return assignExpenseCategory(ccExpenseLineCategoryTarget(opts.lineId), opts);
}
