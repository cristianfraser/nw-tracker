import { fixtureCardLine, fixtureMovement } from "./test/flowFixtures.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "./db.js";
import { ccStatementLineBelongsToCreditCardGroup } from "./ccExpenseCategories.js";
import { assignFlowExpenseLineCategory } from "./expenseAssignmentWrites.js";
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
});
