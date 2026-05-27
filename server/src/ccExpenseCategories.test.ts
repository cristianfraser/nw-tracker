import { describe, expect, it } from "vitest";
import {
  assignCcExpenseCategoryForManualLedgerInstallmentPurchase,
  assignCcExpenseLineCategory,
  countsTowardCcExpenseGastosMes,
  getCcExpenseCategoryBySlug,
  listStatementLineIdsForPurchaseKey,
  loadCcExpenseCategoryMaps,
  normalizeCcExpenseMerchantKey,
  resolveCcExpenseCategorySlug,
  resolveCcExpensePurchaseKey,
  resolveMerchantCategorySlug,
} from "./ccExpenseCategories.js";
import { listCreditCardGroupMasterAccountIds, listCreditCardMasterAccountIds } from "./creditCardTree.js";
import { db } from "./db.js";
import { buildFlowsCreditCardExpensesPayload } from "./flowsCreditCardExpenses.js";
import {
  createManualCcInstallmentPurchase,
  deleteManualCcInstallmentPurchase,
} from "./ccInstallmentManual.js";

describe("ccExpenseCategories", () => {
  it("listCreditCardMasterAccountIds includes active masters from every issuer group", () => {
    const gastos = new Set(listCreditCardMasterAccountIds());
    const santander = listCreditCardGroupMasterAccountIds("santander");
    const bci = listCreditCardGroupMasterAccountIds("bci");
    for (const id of [...santander, ...bci]) {
      expect(gastos.has(id)).toBe(true);
    }
    const id4242 = (
      db
        .prepare(`SELECT id FROM accounts WHERE notes = 'credit_card_master|santander|4242'`)
        .get() as { id: number } | undefined
    )?.id;
    if (id4242) expect(gastos.has(id4242)).toBe(true);
  });

  it("countsTowardCcExpenseGastosMes excludes no_cuenta, deposits, and installment cuota 0", () => {
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
      countsTowardCcExpenseGastosMes("deposits", {
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
        merchantKey: "TEST",
        purchaseKey: "installment:8",
        lineOverrides: new Map(),
        merchantRules: new Map([["15|TEST", "supermarket"]]),
        uniquePurchases: new Map(),
      })
    ).toBe("supermarket");
    expect(
      resolveCcExpenseCategorySlug({
        statementLineId: 4,
        accountId: 15,
        merchantKey: "UNKNOWN",
        purchaseKey: "line:4",
        lineOverrides: new Map(),
        merchantRules: new Map([["15|TEST", "supermarket"]]),
        uniquePurchases: new Map(),
      })
    ).toBe("unclassified");
  });

  it("matches merchant rules by prefix when statement merchant name is longer", () => {
    const rules = new Map([["32|METLIFE CHILE SEGUROS", "bills"]]);
    expect(
      resolveMerchantCategorySlug(32, "METLIFE CHILE SEGUROS DE VIDA", rules)
    ).toBe("bills");
  });

  it("can enable unique purchase mode before a category is chosen", () => {
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
    const { merchantRules } = loadCcExpenseCategoryMaps([line.account_id]);
    const merchantSlug = resolveMerchantCategorySlug(
      line.account_id,
      normalizeCcExpenseMerchantKey(line.merchant),
      merchantRules
    );
    expect(updated?.category_slug).toBe(merchantSlug ?? "unclassified");
  });

  it("merchant assignment applies to same comercio when not marked unique", () => {
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

  it("clear_category removes merchant and unique overrides", () => {
    const payload = buildFlowsCreditCardExpensesPayload();
    const line = payload.lines.find((ln) => ln.amount_clp > 0 && ln.merchant);
    if (!line) return;

    assignCcExpenseLineCategory({
      statementLineId: line.statement_line_id,
      unique: true,
      categorySlug: "fun",
    });

    const cleared = assignCcExpenseLineCategory({
      statementLineId: line.statement_line_id,
      unique: true,
      clearCategory: true,
    });
    expect(cleared.category_slug).toBe("unclassified");
    expect(cleared.unique).toBe(false);

    const after = buildFlowsCreditCardExpensesPayload();
    const updated = after.lines.find((ln) => ln.statement_line_id === line.statement_line_id);
    expect(updated?.category_slug).toBe("unclassified");
    expect(updated?.category_unique).toBe(false);

    const peers = payload.lines.filter(
      (ln) =>
        ln.statement_line_id !== line.statement_line_id &&
        ln.account_id === line.account_id &&
        ln.merchant_key === line.merchant_key &&
        ln.amount_clp > 0
    );
    if (peers.length === 0) return;

    assignCcExpenseLineCategory({
      statementLineId: line.statement_line_id,
      unique: false,
      categorySlug: "supermarket",
    });

    assignCcExpenseLineCategory({
      statementLineId: line.statement_line_id,
      unique: false,
      clearCategory: true,
    });

    const afterMerchantClear = buildFlowsCreditCardExpensesPayload();
    for (const ln of afterMerchantClear.lines.filter(
      (p) =>
        p.account_id === line.account_id &&
        p.merchant_key === line.merchant_key &&
        p.amount_clp > 0 &&
        !p.category_unique
    )) {
      expect(ln.category_slug).toBe("unclassified");
    }
  });

  it("installment cuotas share purchase_key; Único check/uncheck applies to every cuota", () => {
    const payload = buildFlowsCreditCardExpensesPayload();
    const inst = payload.lines.find(
      (ln) =>
        ln.source === "cc" &&
        ln.statement_line_id > 0 &&
        ln.amount_clp > 0 &&
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

  it("assignCcExpenseCategoryForManualLedgerInstallmentPurchase handles consolidated manual (-purchaseId)", () => {
    const master = db
      .prepare(`SELECT id FROM accounts WHERE notes = 'credit_card_master|santander|4242'`)
      .get() as { id: number } | undefined;
    if (!master) return;

    const created = createManualCcInstallmentPurchase(master.id, {
      purchase_date: "2026-05-10",
      total_amount_clp: 50_000,
      cuotas_totales: 10,
      merchant: "TEST_MANUAL_CC_CONSOLIDATED_CAT",
    });
    let purchaseKeyForCleanup: string | null = null;
    try {
      const r = assignCcExpenseCategoryForManualLedgerInstallmentPurchase({
        purchaseId: created.id,
        unique: true,
        categorySlug: "supermarket",
      });
      purchaseKeyForCleanup = r.purchase_key;
      expect(r.purchase_key.startsWith("installment-h:")).toBe(true);
      expect(r.category_slug).toBe("supermarket");
      const up = db
        .prepare(
          `SELECT 1 FROM cc_expense_unique_purchases WHERE account_id = ? AND purchase_key = ?`
        )
        .get(master.id, r.purchase_key);
      expect(up).toBeDefined();
    } finally {
      if (purchaseKeyForCleanup) {
        db.prepare(`DELETE FROM cc_expense_unique_purchases WHERE account_id = ? AND purchase_key = ?`).run(
          master.id,
          purchaseKeyForCleanup
        );
      }
      deleteManualCcInstallmentPurchase(master.id, created.id);
    }
  });
});
