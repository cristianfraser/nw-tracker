import { describe, expect, it } from "vitest";
import { db } from "./db.js";
import { ccStatementLineBelongsToCreditCardGroup } from "./ccExpenseCategories.js";
import { assignFlowExpenseLineCategory } from "./assignFlowExpenseLineCategory.js";
import { checkingGastosMovementBelongs } from "./flowsCheckingGastos.js";
import { buildFlowsCreditCardExpensesPayload } from "./flowsCreditCardExpenses.js";

describe("assignFlowExpenseLineCategory", () => {
  it("disambiguates id collision between checking movement and cc statement line", () => {
    const checking = checkingGastosMovementBelongs(999);
    const cc = ccStatementLineBelongsToCreditCardGroup(999);
    if (!checking.ok || !cc.ok) return;

    const checkingResult = assignFlowExpenseLineCategory({
      lineId: 999,
      source: "checking",
      unique: true,
    });
    expect(checkingResult.purchase_key).toBe("checking-mv:999");
    expect(checkingResult.merchant_key).not.toBe("OKM SUECIA");

    const ccResult = assignFlowExpenseLineCategory({
      lineId: 999,
      source: "cc",
      unique: true,
      categorySlug: "supermarket",
    });
    expect(ccResult.purchase_key).toMatch(/^line-pr:/);
    expect(ccResult.merchant_key).toBe("OKM SUECIA");

    db.prepare(
      `DELETE FROM cc_expense_unique_purchases WHERE account_id = ? AND purchase_key = ?`
    ).run(checking.account_id, checkingResult.purchase_key);
    db.prepare(
      `DELETE FROM cc_expense_unique_purchases WHERE account_id = ? AND purchase_key = ?`
    ).run(cc.account_id!, ccResult.purchase_key);
  });

  it("throws when source is omitted and both checking and cc rows share the id", () => {
    const checking = checkingGastosMovementBelongs(999);
    const cc = ccStatementLineBelongsToCreditCardGroup(999);
    if (!checking.ok || !cc.ok) return;

    expect(() =>
      assignFlowExpenseLineCategory({ lineId: 999, unique: true })
    ).toThrow(/ambiguous/i);
  });

  it("Mercado Capitales checking line shows unique after assign with source checking", () => {
    const checking = checkingGastosMovementBelongs(999);
    const cc = ccStatementLineBelongsToCreditCardGroup(999);
    if (!checking.ok || !cc.ok) return;

    assignFlowExpenseLineCategory({
      lineId: 999,
      source: "checking",
      unique: true,
      categorySlug: "deposits",
    });

    try {
      const payload = buildFlowsCreditCardExpensesPayload();
      const mc = payload.lines.find(
        (ln) => ln.source === "checking" && ln.statement_line_id === 999
      );
      expect(mc?.category_unique).toBe(true);
      expect(mc?.category_slug).toBe("deposits");

      const okm = payload.lines.find(
        (ln) => ln.source === "cc" && ln.statement_line_id === 999
      );
      expect(okm?.category_unique).not.toBe(true);
    } finally {
      assignFlowExpenseLineCategory({
        lineId: 999,
        source: "checking",
        unique: false,
        clearCategory: true,
      });
    }
  });
});
