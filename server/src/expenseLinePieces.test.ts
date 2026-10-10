import { afterAll, describe, expect, it } from "vitest";
import { getCcExpenseCategoryBySlug } from "./ccExpenseCategories.js";
import { db } from "./db.js";
import { expandLineSplitsInDrafts, type FlowCcExpenseLineRowDraft } from "./flowsExpenses.js";
import {
  createManualExpense,
  deleteManualExpense,
  loadManualExpenseGastosLineDrafts,
  updateManualExpense,
} from "./flowsManualExpenses.js";

// A movement id no fixture uses: the splits table keys pieces by (source, line id) only.
const LINE_ID = 987_654_321;

function withdrawal(): FlowCcExpenseLineRowDraft {
  return {
    source: "checking",
    statement_line_id: LINE_ID,
    account_id: 1,
    expense_month: "2021-11",
    billing_month: "2021-11",
    purchase_month: "2021-11",
    occurred_on: "2021-11-22",
    purchase_on: "2021-11-22",
    statement_date: "",
    amount_clp: 150_000,
    amount_usd: null,
    amount_usd_at_expense: 180,
    merchant: "Giro en Cajero Automatico",
    merchant_key: "GIRO EN CAJERO AUTOMATICO",
    category_slug: "others",
    category_unique: false,
    installment_flag: 0,
    nro_cuota_current: null,
    nro_cuota_total: null,
    line_role: "purchase",
    origin_card_last4: null,
    primary_card_last4: null,
  } as FlowCcExpenseLineRowDraft;
}

function insertPiece(seq: number, slug: string, amount: number, spentOn: string | null): void {
  db.prepare(
    `INSERT INTO cc_expense_line_splits (source, line_id, seq, category_id, amount_clp, spent_on)
     VALUES ('checking', ?, ?, ?, ?, ?)`
  ).run(LINE_ID, seq, getCcExpenseCategoryBySlug(slug)!.id, amount, spentOn);
}

function clearPieces(): void {
  db.prepare(`DELETE FROM cc_expense_line_splits WHERE source = 'checking' AND line_id = ?`).run(LINE_ID);
}

describe("line pieces", () => {
  afterAll(clearPieces);

  it("dates each piece and keeps what the pieces leave on the line's own day", () => {
    clearPieces();
    insertPiece(0, "food", 40_000, "2021-11-24");
    insertPiece(1, "transportation", 25_000, null);
    const out = expandLineSplitsInDrafts([withdrawal()]);
    expect(out.map((l) => [l.purchase_on, l.amount_clp, l.category_slug, l.piece_seq ?? null, l.pieces_remainder ?? null])).toEqual([
      ["2021-11-24", 40_000, "food", 0, null],
      ["2021-11-22", 25_000, "transportation", 1, null],
      ["2021-11-22", 85_000, "others", null, true],
    ]);
    expect(out[0]!.expense_month).toBe("2021-11");
    expect(out.reduce((s, l) => s + l.amount_clp, 0)).toBe(150_000);
  });

  it("leaves no remainder when the pieces cover the line", () => {
    clearPieces();
    insertPiece(0, "food", 150_000, null);
    expect(expandLineSplitsInDrafts([withdrawal()]).map((l) => l.amount_clp)).toEqual([150_000]);
  });

  it("refuses pieces adding up to more than the line", () => {
    clearPieces();
    insertPiece(0, "food", 100_000, null);
    insertPiece(1, "food", 60_000, null);
    expect(() => expandLineSplitsInDrafts([withdrawal()])).toThrow(/more than the line/);
  });

  it("never splits a checking movement's deposit-paired portion", () => {
    clearPieces();
    insertPiece(0, "food", 40_000, null);
    const deposit = { ...withdrawal(), checking_purchase_portion: "deposit" as const };
    expect(expandLineSplitsInDrafts([deposit])).toEqual([deposit]);
  });
});

describe("manual expenses", () => {
  it("creates, edits and deletes one, showing what was written", () => {
    const { id } = createManualExpense({
      spent_on: "2021-09-25",
      amount_clp: 12_000,
      category_slug: "food",
      description: "vitest cash lunch",
    });
    const line = () => loadManualExpenseGastosLineDrafts().find((l) => l.statement_line_id === id);
    expect(line()?.merchant).toBe("vitest cash lunch");
    updateManualExpense(id, { spent_on: "2021-09-26", amount_clp: 13_000, category_slug: "fun", description: "vitest bar" });
    expect([line()?.purchase_on, line()?.amount_clp, line()?.category_slug]).toEqual(["2021-09-26", 13_000, "fun"]);
    expect(() =>
      updateManualExpense(id, { spent_on: "2021-09-26", amount_clp: 0, category_slug: "fun", description: "x" })
    ).toThrow(/above 0/);
    deleteManualExpense(id);
    expect(line()).toBeUndefined();
  });
});
