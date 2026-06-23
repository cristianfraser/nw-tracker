import { monthKeyFromYmd } from "./calendarMonth.js";
import {
  getCcExpenseCategoryBySlug,
  isCcExpenseTotalsExcludedSlug,
  normalizeCcExpenseMerchantKey,
} from "./ccExpenseCategories.js";
import { db } from "./db.js";
import { expenseGastosAmountUsdAtDate } from "./flowMoneyAtDate.js";
import type { FlowCcExpenseLineRowDraft } from "./flowsCreditCardExpenses.js";

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
  if (row.category === EXCEL_TOTAL_CATEGORY) return false;
  const note = row.note ?? "";
  if (note.startsWith("import:excel")) return false;
  if (note.startsWith("import:depto")) return false;
  return true;
}

function loadManualExpenseEntryRows(): ManualExpenseEntryRow[] {
  return db
    .prepare(
      `SELECT id, amount_clp, spent_on, category, note
       FROM expense_entries
       WHERE category IS NOT NULL
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
    const merchant = String(row.note ?? "").trim() || categorySlug;

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
      amount_usd_at_expense: expenseGastosAmountUsdAtDate(amountClp, row.spent_on),
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
