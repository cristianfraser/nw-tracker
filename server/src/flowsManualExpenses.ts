import { monthKeyFromYmd } from "./calendarMonth.js";
import {
  getCcExpenseCategoryBySlug,
  isCcExpenseTotalsExcludedSlug,
  normalizeCcExpenseMerchantKey,
} from "./ccExpenseCategories.js";
import { db } from "./db.js";
import { expenseGastosAmountUsdAtDate } from "./flowMoneyAtDate.js";
import type { FlowCcExpenseLineRowDraft } from "./flowsExpenses.js";

const EXCEL_TOTAL_CATEGORY = "Total mensual (Gasto)";

type ManualExpenseEntryRow = {
  id: number;
  amount_clp: number;
  spent_on: string;
  category: string;
  note: string | null;
};

export function validateManualExpenseCategorySlug(category: string | null | undefined): string {
  const slug = String(category ?? "").trim();
  if (!slug) throw new Error("category required");
  if (slug === EXCEL_TOTAL_CATEGORY) throw new Error("invalid category");
  if (!getCcExpenseCategoryBySlug(slug)) throw new Error(`unknown category slug: ${slug}`);
  if (isCcExpenseTotalsExcludedSlug(slug)) throw new Error(`category not allowed: ${slug}`);
  return slug;
}

export function normalizeManualExpenseNote(note: string | null | undefined): string | null {
  const t = String(note ?? "").trim();
  if (!t) return "manual:";
  if (t.startsWith("manual:") || t.startsWith("synthetic:")) return t;
  return `manual:${t}`;
}

function isFlowsManualExpenseEntryRow(row: ManualExpenseEntryRow): boolean {
  return row.category !== EXCEL_TOTAL_CATEGORY;
}

/**
 * Generic manual expenses only: rows tied to a place (`expense_account_id`) are
 * real-estate bill expectations — their money already flows through the linked
 * CC/checking purchase, so counting the bill here would double it.
 */
function loadManualExpenseEntryRows(): ManualExpenseEntryRow[] {
  return db
    .prepare(
      `SELECT id, amount_clp, spent_on, category, note
       FROM expense_entries
       WHERE category IS NOT NULL AND expense_account_id IS NULL
       ORDER BY spent_on, id`
    )
    .all() as ManualExpenseEntryRow[];
}

export function loadManualExpenseGastosLineDrafts(): FlowCcExpenseLineRowDraft[] {
  const lines: FlowCcExpenseLineRowDraft[] = [];

  for (const row of loadManualExpenseEntryRows()) {
    if (!isFlowsManualExpenseEntryRow(row)) continue;

    const categorySlug = validateManualExpenseCategorySlug(row.category);
    const expenseMonth = monthKeyFromYmd(row.spent_on);
    const amountClp = Math.round(row.amount_clp);
    // The `manual:` prefix is provenance; the line shows what was written after it.
    const merchant = String(row.note ?? "").replace(/^manual:/, "").trim() || categorySlug;

    lines.push({
      source: "manual",
      statement_line_id: row.id,
      account_id: 0,
      expense_month: expenseMonth,
      billing_month: expenseMonth,
      purchase_month: expenseMonth,
      occurred_on: row.spent_on,
      purchase_on: row.spent_on,
      statement_date: "",
      amount_clp: amountClp,
      amount_usd: null,
      amount_usd_at_expense: expenseGastosAmountUsdAtDate(amountClp, null, row.spent_on),
      merchant,
      merchant_key: normalizeCcExpenseMerchantKey(merchant),
      category_slug: categorySlug,
      category_unique: false,
      installment_flag: 0,
      nro_cuota_current: null,
      nro_cuota_total: null,
      line_role: "purchase",
      origin_card_last4: null,
      primary_card_last4: null,
    });
  }

  return lines;
}

export type ManualExpenseInput = {
  spent_on: string;
  amount_clp: number;
  category_slug: string;
  /** What it was; stored with the `manual:` provenance prefix and shown as the line's merchant. */
  description: string;
};

function validManualExpense(input: ManualExpenseInput): {
  spentOn: string;
  amountClp: number;
  category: string;
  note: string | null;
} {
  const spentOn = String(input.spent_on ?? "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(spentOn)) throw new Error(`spent_on must be YYYY-MM-DD, got ${spentOn}`);
  const amountClp = Number(input.amount_clp);
  if (!Number.isInteger(amountClp) || amountClp <= 0) {
    throw new Error(`amount_clp must be a whole number of pesos above 0, got ${input.amount_clp}`);
  }
  const description = String(input.description ?? "").trim();
  if (!description) throw new Error("description required");
  return {
    spentOn,
    amountClp,
    category: validateManualExpenseCategorySlug(input.category_slug),
    note: normalizeManualExpenseNote(description),
  };
}

/** A manual expense row this API may edit: generic (no place) and not a pre-baseline monthly total. */
function requireEditableManualExpense(id: number): void {
  const row = db
    .prepare(`SELECT category, expense_account_id FROM expense_entries WHERE id = ?`)
    .get(id) as { category: string | null; expense_account_id: number | null } | undefined;
  if (!row) throw new Error(`manual expense ${id} not found`);
  if (row.expense_account_id != null) throw new Error(`expense ${id} is a real-estate bill, not a manual expense`);
  if (row.category == null || row.category === EXCEL_TOTAL_CATEGORY) {
    throw new Error(`expense ${id} is not a manual expense line`);
  }
}

export function createManualExpense(input: ManualExpenseInput): { id: number } {
  const v = validManualExpense(input);
  const result = db
    .prepare(`INSERT INTO expense_entries (amount_clp, spent_on, category, note) VALUES (?, ?, ?, ?)`)
    .run(v.amountClp, v.spentOn, v.category, v.note);
  return { id: Number(result.lastInsertRowid) };
}

export function updateManualExpense(id: number, input: ManualExpenseInput): void {
  requireEditableManualExpense(id);
  const v = validManualExpense(input);
  db.prepare(`UPDATE expense_entries SET amount_clp = ?, spent_on = ?, category = ?, note = ? WHERE id = ?`).run(
    v.amountClp,
    v.spentOn,
    v.category,
    v.note,
    id
  );
}

/** Deletes a manual expense and the big group it carried (keyed `manual:<id>`). */
export function deleteManualExpense(id: number): void {
  requireEditableManualExpense(id);
  db.transaction(() => {
    db.prepare(`DELETE FROM cc_expense_purchase_big_groups WHERE purchase_key = ?`).run(`manual:${id}`);
    db.prepare(`DELETE FROM expense_entries WHERE id = ?`).run(id);
  })();
}
