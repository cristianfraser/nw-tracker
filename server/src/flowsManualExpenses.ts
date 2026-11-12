import { monthKeyFromYmd } from "./calendarMonth.js";
import {
  getCcExpenseCategoryBySlug,
  isCcExpenseTotalsExcludedSlug,
  normalizeCcExpenseMerchantKey,
} from "./ccExpenseCategories.js";
import { db } from "./db.js";
import { deleteKeyedRow } from "./flows/flowKeyedAssignments.js";
import { buildExpenseKey } from "./expenseKeys.js";
import { coreCurrencyCodes, currencyMinorDigits, roundToCurrency } from "./displayUnits.js";
import { expenseGastosAmountUsdAtDate } from "./flowMoneyAtDate.js";
import { convertFlow } from "./rates.js";
import type { FlowCcExpenseLineRowDraft } from "./flowsExpenses.js";

const EXCEL_TOTAL_CATEGORY = "Total mensual (Gasto)";

type ManualExpenseEntryRow = {
  id: number;
  /** In `currency` (any currency of `currencies`; migration 316). */
  amount: number;
  currency: string;
  spent_on: string;
  category: string;
  /** What it was, as the user wrote it (migration 275); null = the line shows its category. */
  merchant: string | null;
};

export function validateManualExpenseCategorySlug(category: string | null | undefined): string {
  const slug = String(category ?? "").trim();
  if (!slug) throw new Error("category required");
  if (slug === EXCEL_TOTAL_CATEGORY) throw new Error("invalid category");
  if (!getCcExpenseCategoryBySlug(slug)) throw new Error(`unknown category slug: ${slug}`);
  if (isCcExpenseTotalsExcludedSlug(slug)) throw new Error(`category not allowed: ${slug}`);
  return slug;
}

/** The note's provenance prefix (human text: the line's name is the `merchant` column). */
const MANUAL_NOTE_PREFIX = "manual:";

export function normalizeManualExpenseNote(note: string | null | undefined): string | null {
  const t = String(note ?? "").trim();
  if (!t) return MANUAL_NOTE_PREFIX;
  if (t.startsWith(MANUAL_NOTE_PREFIX) || t.startsWith("synthetic:")) return t;
  return `${MANUAL_NOTE_PREFIX}${t}`;
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
      `SELECT id, amount, currency, spent_on, category, merchant
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
    // A manual expense is spent in its own currency; its pesos are the day's (mid), the dollars of
    // a peso expense the day's buy rate as they always were.
    const amountClp = Math.round(convertFlow(row.amount, row.currency, "clp", row.spent_on));
    const usdAtExpense =
      row.currency === "clp" // convention-ok: a peso expense keeps the buy-rate dollars it always read
        ? expenseGastosAmountUsdAtDate(amountClp, null, row.spent_on)
        : convertFlow(row.amount, row.currency, "usd", row.spent_on);
    const merchant = row.merchant?.trim() || categorySlug;

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
      amount: { value: row.amount, currency: row.currency },
      amount_clp: amountClp,
      amount_usd: null,
      amount_usd_at_expense: usdAtExpense,
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
  /** In `currency`, to its smallest coin (whole pesos, cents of a dollar or a euro). */
  amount: number;
  /** A core currency of `currencies`. */
  currency: string;
  category_slug: string;
  /** What it was: the line's merchant, and the note (with its `manual:` provenance prefix). */
  description: string;
};

function validManualExpense(input: ManualExpenseInput): {
  spentOn: string;
  amount: number;
  currency: string;
  category: string;
  note: string | null;
  merchant: string;
} {
  const spentOn = String(input.spent_on ?? "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(spentOn)) throw new Error(`spent_on must be YYYY-MM-DD, got ${spentOn}`);
  const currency = String(input.currency ?? "").trim();
  if (!coreCurrencyCodes().includes(currency)) {
    throw new Error(`currency must be one of ${coreCurrencyCodes().join(", ")}, got ${JSON.stringify(input.currency)}`);
  }
  const amount = Number(input.amount);
  if (!Number.isFinite(amount) || amount <= 0 || roundToCurrency(amount, currency) !== amount) {
    throw new Error(
      `amount must be above 0 in ${currency}, to ${currencyMinorDigits(currency)} decimal(s), got ${input.amount}`
    );
  }
  const description = String(input.description ?? "").trim();
  if (!description) throw new Error("description required");
  return {
    spentOn,
    amount,
    currency,
    category: validateManualExpenseCategorySlug(input.category_slug),
    note: normalizeManualExpenseNote(description),
    merchant: description,
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
    .prepare(`INSERT INTO expense_entries (amount, currency, spent_on, category, note, merchant) VALUES (?, ?, ?, ?, ?, ?)`)
    .run(v.amount, v.currency, v.spentOn, v.category, v.note, v.merchant);
  return { id: Number(result.lastInsertRowid) };
}

export function updateManualExpense(id: number, input: ManualExpenseInput): void {
  requireEditableManualExpense(id);
  const v = validManualExpense(input);
  db.transaction(() => {
    db.prepare(
      `UPDATE expense_entries SET amount = ?, currency = ?, spent_on = ?, category = ?, note = ?, merchant = ? WHERE id = ?`
    ).run(v.amount, v.currency, v.spentOn, v.category, v.note, v.merchant, id);
    // The flow and its evidence state the row's amount (the insert trigger wrote them once).
    db.prepare(
      `UPDATE flows SET amount = ?, currency = ?
       WHERE id = (SELECT flow_id FROM expense_entries WHERE id = ?)`
    ).run(v.amount, v.currency, id);
    db.prepare(
      `UPDATE flow_evidence SET stated_amount = ?, stated_currency = ?
       WHERE source_table = 'expense_entries' AND source_row_id = ?`
    ).run(v.amount, v.currency, id);
  })();
}

/** Deletes a manual expense and the big group it carried (keyed `manual:<id>`). */
export function deleteManualExpense(id: number): void {
  requireEditableManualExpense(id);
  db.transaction(() => {
    deleteKeyedRow("flow_big_groups", buildExpenseKey({ kind: "manual", entryId: id }));
    db.prepare(`DELETE FROM expense_entries WHERE id = ?`).run(id);
  })();
}
