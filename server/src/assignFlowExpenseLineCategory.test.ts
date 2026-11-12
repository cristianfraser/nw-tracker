import { fixtureCardLine, fixtureMovement } from "./test/flowFixtures.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "./db.js";
import { ccStatementLineBelongsToCreditCardGroup } from "./ccExpenseCategories.js";
import { assignFlowExpenseLineCategory } from "./expenseAssignmentWrites.js";
import { hasGeneralRule } from "./expenseCategoryRules.js";
import { checkingGastosMovementBelongs } from "./flowsCheckingGastos.js";
import { buildFlowsExpensesPayload } from "./flowsExpenses.js";

/** One id that is both a checking movement and a card line (two documents, two flows). */
const SHARED_ID = 987_654_321;

describe("assignFlowExpenseLineCategory", () => {
  const cleanups: (() => void)[] = [];
  beforeAll(() => {
    cleanups.push(fixtureMovement(SHARED_ID, -4321, "2021-11-22"), fixtureCardLine(SHARED_ID));
    // A cartola row, so the checking reader takes it as a withdrawal (the cartola identity is still its note).
    db.prepare(`UPDATE movements SET note = ? WHERE id = ?`).run(
      "import:cartola|2021-11|Agustinas|COMPRA VITEST FIXTURE|on:2021-11-22|amt:-4321|idx:0",
      SHARED_ID
    );
    expect(checkingGastosMovementBelongs(SHARED_ID).ok).toBe(true);
    expect(ccStatementLineBelongsToCreditCardGroup(SHARED_ID).ok).toBe(true);
  });
  afterAll(() => {
    for (const c of cleanups.reverse()) c();
  });

  it("disambiguates id collision between checking movement and cc statement line", () => {
    const checkingResult = assignFlowExpenseLineCategory({ lineId: SHARED_ID, source: "checking", unique: true });
    expect(checkingResult.purchase_key).toMatch(new RegExp(`^checking-(mv:${SHARED_ID}|cartola:)`));
    expect(checkingResult.merchant_key).not.toBe("VITEST FIXTURE LINE");

    const ccResult = assignFlowExpenseLineCategory({
      lineId: SHARED_ID,
      source: "cc",
      unique: true,
      categorySlug: "supermarket",
    });
    expect(ccResult.purchase_key).not.toMatch(/^checking-/);
    expect(ccResult.merchant_key).toBe("VITEST FIXTURE LINE");

    assignFlowExpenseLineCategory({ lineId: SHARED_ID, source: "checking", unique: false, clearCategory: true });
    assignFlowExpenseLineCategory({ lineId: SHARED_ID, source: "cc", unique: false, clearCategory: true });
  });

  it("throws when source is omitted and both checking and cc rows share the id", () => {
    expect(() => assignFlowExpenseLineCategory({ lineId: SHARED_ID, unique: true })).toThrow(/ambiguous/i);
  });

  it("a checking line shows unique after assign with source checking, the card line with that id does not", () => {
    assignFlowExpenseLineCategory({ lineId: SHARED_ID, source: "checking", unique: true, categorySlug: "deposits" });
    try {
      const payload = buildFlowsExpensesPayload();
      const checkingLine = payload.lines.find((ln) => ln.source === "checking" && ln.statement_line_id === SHARED_ID);
      expect(checkingLine?.category_unique).toBe(true);
      expect(checkingLine?.category_slug).toBe("deposits");

      const cardLine = payload.lines.find((ln) => ln.source === "cc" && ln.statement_line_id === SHARED_ID);
      expect(cardLine).toBeDefined();
      expect(cardLine?.category_unique).not.toBe(true);
    } finally {
      assignFlowExpenseLineCategory({ lineId: SHARED_ID, source: "checking", unique: false, clearCategory: true });
    }
  });

  it("an additional cardholder's line keeps its category as its own and writes no merchant rule", () => {
    const id = SHARED_ID + 1;
    const cleanup = fixtureCardLine(id);
    try {
      // 4999 is the fixture registry's additional card; the statement's own card is another.
      db.prepare(`UPDATE cc_statement_lines SET origin_card_last4 = '4999', merchant = 'VITEST ADDITIONAL MERCHANT' WHERE id = ?`).run(id);
      db.prepare(`UPDATE cc_statements SET card_last4 = '4242' WHERE id = (SELECT statement_id FROM cc_statement_lines WHERE id = ?)`).run(id);
      const r = assignFlowExpenseLineCategory({ lineId: id, source: "cc", unique: false, categorySlug: "food" });
      expect(r.unique).toBe(true);
      expect(hasGeneralRule("VITEST ADDITIONAL MERCHANT")).toBe(false);
    } finally {
      assignFlowExpenseLineCategory({ lineId: id, source: "cc", unique: true, clearCategory: true });
      cleanup();
    }
  });
});
