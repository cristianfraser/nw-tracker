import { describe, expect, it } from "vitest";
import {
  assignCcExpenseLineCategory,
  countsTowardCcExpenseGastosMes,
  getCcExpenseCategoryBySlug,
  listCreditCardGroupOperationalAccountIds,
  listStatementLineIdsForPurchaseKey,
  normalizeCcExpenseMerchantKey,
  resolveCcExpenseCategorySlug,
  resolveCcExpensePurchaseKey,
} from "./ccExpenseCategories.js";
import { buildFlowsCreditCardExpensesPayload } from "./flowsCreditCardExpenses.js";

describe("ccExpenseCategories", () => {
  it("countsTowardCcExpenseGastosMes excludes no_cuenta and installment cuota 0", () => {
    expect(
      countsTowardCcExpenseGastosMes("supermarket", {
        installment_flag: 1,
        nro_cuota_current: 3,
      })
    ).toBe(true);
    expect(
      countsTowardCcExpenseGastosMes("no_cuenta", {
        installment_flag: 0,
        nro_cuota_current: null,
      })
    ).toBe(false);
    expect(
      countsTowardCcExpenseGastosMes("salud", {
        installment_flag: 1,
        nro_cuota_current: 0,
      })
    ).toBe(false);
  });

  it("normalizes merchant keys for stable matching", () => {
    expect(normalizeCcExpenseMerchantKey("  roca   webpay ")).toBe("ROCA WEBPAY");
  });

  it("unique purchase trumps merchant rule; siblings share purchase key", () => {
    expect(
      resolveCcExpenseCategorySlug({
        statementLineId: 1,
        accountId: 15,
        merchantKey: "TEST",
        purchaseKey: "installment:8",
        lineOverrides: new Map(),
        merchantRules: new Map([["15|TEST", "supermarket"]]),
        uniquePurchases: new Map([["15|installment:8", "fun"]]),
      })
    ).toBe("fun");
    expect(
      resolveCcExpenseCategorySlug({
        statementLineId: 2,
        accountId: 15,
        merchantKey: "TEST",
        purchaseKey: "installment:8",
        lineOverrides: new Map([[1, "others"]]),
        merchantRules: new Map([["15|TEST", "supermarket"]]),
        uniquePurchases: new Map([["15|installment:8", "fun"]]),
      })
    ).toBe("fun");
    expect(
      resolveCcExpenseCategorySlug({
        statementLineId: 3,
        accountId: 15,
        merchantKey: "UNKNOWN",
        purchaseKey: "line:3",
        lineOverrides: new Map(),
        merchantRules: new Map([["15|TEST", "supermarket"]]),
        uniquePurchases: new Map([["15|installment:8", null]]),
      })
    ).toBe("unclassified");
  });

  it("can enable unique purchase mode before a category is chosen", () => {
    const accounts = listCreditCardGroupOperationalAccountIds();
    if (accounts.length === 0) return;

    const payload = buildFlowsCreditCardExpensesPayload();
    const line = payload.lines.find((ln) => ln.amount_clp > 0);
    if (!line) return;

    const result = assignCcExpenseLineCategory({
      statementLineId: line.statement_line_id,
      unique: true,
    });
    expect(result.unique).toBe(true);
    expect(result.category_slug).toBe("unclassified");
    expect(result.purchase_key).toMatch(/^(line-pr:|installment-h:|installment-pr:)/);

    const after = buildFlowsCreditCardExpensesPayload();
    const updated = after.lines.find((ln) => ln.statement_line_id === line.statement_line_id);
    expect(updated?.category_unique).toBe(true);
    expect(updated?.category_slug).toBe("unclassified");
  });

  it("merchant assignment applies to same comercio when not marked unique", () => {
    const accounts = listCreditCardGroupOperationalAccountIds();
    if (accounts.length === 0) return;

    const payload = buildFlowsCreditCardExpensesPayload();
    const line = payload.lines.find((ln) => {
      if (ln.amount_clp <= 0 || !ln.merchant || ln.category_unique) return false;
      const peers = payload.lines.filter(
        (p) =>
          p.statement_line_id !== ln.statement_line_id &&
          p.account_id === ln.account_id &&
          p.merchant_key === ln.merchant_key &&
          p.amount_clp > 0 &&
          !p.category_unique
      );
      return peers.length > 0;
    });
    if (!line) return;

    const supermarket = getCcExpenseCategoryBySlug("supermarket");
    if (!supermarket) return;

    assignCcExpenseLineCategory({
      statementLineId: line.statement_line_id,
      unique: false,
      categorySlug: "supermarket",
    });

    const after = buildFlowsCreditCardExpensesPayload();
    const sameMerchant = after.lines.filter(
      (ln) =>
        ln.account_id === line.account_id &&
        ln.merchant_key === line.merchant_key &&
        ln.amount_clp > 0 &&
        !ln.category_unique
    );
    expect(sameMerchant.length).toBeGreaterThan(1);
    for (const ln of sameMerchant) {
      expect(ln.category_slug).toBe("supermarket");
    }

    assignCcExpenseLineCategory({
      statementLineId: line.statement_line_id,
      unique: true,
      categorySlug: "others",
    });

    const uniqueAfter = buildFlowsCreditCardExpensesPayload();
    const onlyLine = uniqueAfter.lines.find((ln) => ln.statement_line_id === line.statement_line_id);
    expect(onlyLine?.category_slug).toBe("others");
    expect(onlyLine?.category_unique).toBe(true);

    const peers = uniqueAfter.lines.filter(
      (ln) =>
        ln.statement_line_id !== line.statement_line_id &&
        ln.account_id === line.account_id &&
        ln.merchant_key === line.merchant_key &&
        ln.amount_clp > 0 &&
        !ln.category_unique
    );
    if (peers.length > 0) {
      for (const peer of peers) {
        expect(peer.category_slug).toBe("supermarket");
      }
    }
  });

  it("installment cuotas share purchase_key; Único check/uncheck applies to every cuota", () => {
    const payload = buildFlowsCreditCardExpensesPayload();
    const inst = payload.lines.find(
      (ln) =>
        ln.installment_flag === 1 &&
        ln.nro_cuota_total != null &&
        ln.nro_cuota_total >= 3 &&
        ln.merchant?.includes("ROCA") &&
        ln.purchase_on != null
    );
    if (!inst) return;

    const purchaseKey = resolveCcExpensePurchaseKey(inst.statement_line_id);
    expect(purchaseKey).toMatch(/^installment-(h|pr):/);

    const cuotaLineIds = listStatementLineIdsForPurchaseKey(
      inst.statement_line_id,
      purchaseKey
    );
    expect(cuotaLineIds.length).toBeGreaterThan(1);
    for (const lineId of cuotaLineIds) {
      expect(resolveCcExpensePurchaseKey(lineId)).toBe(purchaseKey);
    }

    const checkOnly = assignCcExpenseLineCategory({
      statementLineId: inst.statement_line_id,
      unique: true,
    });
    expect(checkOnly.purchase_key).toBe(purchaseKey);
    expect(checkOnly.unique).toBe(true);

    const afterCheck = buildFlowsCreditCardExpensesPayload();
    for (const lineId of cuotaLineIds) {
      const ln = afterCheck.lines.find((l) => l.statement_line_id === lineId);
      expect(ln?.category_unique).toBe(true);
    }

    assignCcExpenseLineCategory({
      statementLineId: inst.statement_line_id,
      unique: true,
      categorySlug: "fun",
    });

    const afterCategory = buildFlowsCreditCardExpensesPayload();
    for (const lineId of cuotaLineIds) {
      const ln = afterCategory.lines.find((l) => l.statement_line_id === lineId);
      expect(ln?.category_slug).toBe("fun");
      expect(ln?.category_unique).toBe(true);
    }

    assignCcExpenseLineCategory({
      statementLineId: inst.statement_line_id,
      unique: false,
      categorySlug: "fun",
    });

    const afterUncheck = buildFlowsCreditCardExpensesPayload();
    for (const lineId of cuotaLineIds) {
      const ln = afterUncheck.lines.find((l) => l.statement_line_id === lineId);
      expect(ln?.category_slug).toBe("fun");
      expect(ln?.category_unique).toBe(false);
    }
  });
});
