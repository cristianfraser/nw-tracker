import { describe, expect, it } from "vitest";
import { isAdditionalCardExpenseLine } from "./ccAdditionalCardExpenseMatch.js";
import {
  assignCcExpenseCategoryForManualLedgerInstallmentPurchase,
  assignCcExpenseLineCategory,
  categoryUniqueForExpenseLine,
  countsTowardCcExpenseGastosMes,
  getCcExpenseCategoryBySlug,
  listStatementLineIdsForPurchaseKey,
  loadCcExpenseCategoryMaps,
  normalizeCcExpenseMerchantKey,
  resolveCcExpenseCategorySlug,
  resolveCcExpensePurchaseKey,
  resolveMerchantCategorySlug,
  isGenericTransferMerchantKey,
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
      countsTowardCcExpenseGastosMes("checking_internal_transfer", {
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

  it("matches merchant rules by exact merchant_key only", () => {
    const rules = new Map([["32|METLIFE CHILE SEGUROS", "bills"]]);
    expect(
      resolveMerchantCategorySlug(32, "METLIFE CHILE SEGUROS DE VIDA", rules)
    ).toBeNull();
    expect(resolveMerchantCategorySlug(32, "METLIFE CHILE SEGUROS", rules)).toBe("bills");
  });

  it("does not apply UBER rule to UBER EATS", () => {
    const rules = new Map([["32|UBER", "transportation"]]);
    expect(resolveMerchantCategorySlug(32, "UBER EATS", rules)).toBeNull();
    expect(resolveMerchantCategorySlug(32, "UBER", rules)).toBe("transportation");
  });

  it("detects generic transfer merchant keys", () => {
    expect(isGenericTransferMerchantKey("TRANSFERENCIA")).toBe(true);
    expect(isGenericTransferMerchantKey("TRANSF")).toBe(true);
    expect(isGenericTransferMerchantKey("TRANSF. INTERNET A OTRO BANCOS")).toBe(true);
    expect(isGenericTransferMerchantKey("TRANSF.INTERNET A 3O MISMO BCO")).toBe(true);
    expect(isGenericTransferMerchantKey("TRANSFERENCIA A 3RO MISMO BANCO")).toBe(true);
    expect(isGenericTransferMerchantKey("MACH ONE CLICK")).toBe(true);
    expect(isGenericTransferMerchantKey("MACH WEBPAY ONECLICK")).toBe(true);
    expect(isGenericTransferMerchantKey("TRASPASO A CUENTA DE OTRO BANCO")).toBe(true);
    expect(isGenericTransferMerchantKey("1234567890 CARGO MERCADO CAPITALES")).toBe(true);
    expect(isGenericTransferMerchantKey("CARGO MERCADO CAPITALES")).toBe(true);
    expect(isGenericTransferMerchantKey("TRANSFERENCIA A JUAN PEREZ")).toBe(false);
    expect(isGenericTransferMerchantKey("TRANSF 123456")).toBe(false);
    expect(isGenericTransferMerchantKey("TRANSF. A PEDRO PAINEL GAJARDO")).toBe(false);
    expect(isGenericTransferMerchantKey("0768106274 TRANSF A FINTUAL")).toBe(false);
  });

  it("generic transfer merchants skip merchant rules", () => {
    expect(
      resolveCcExpenseCategorySlug({
        statementLineId: 1,
        accountId: 15,
        merchantKey: "TRANSF. INTERNET A OTRO BANCOS",
        purchaseKey: "checking-mv:1",
        lineOverrides: new Map(),
        merchantRules: new Map([["15|TRANSF. INTERNET A OTRO BANCOS", "deposits"]]),
        uniquePurchases: new Map(),
      })
    ).toBe("unclassified");
  });

  it("does not assign no_cuenta for installment-h key when purchase is active", () => {
    expect(
      resolveCcExpenseCategorySlug({
        statementLineId: 1,
        accountId: 15,
        merchantKey: "ROCA WEBPAY",
        purchaseKey: "installment-h:15:2025-04-15:12:ROCA WEBPAY",
        lineOverrides: new Map(),
        merchantRules: new Map(),
        uniquePurchases: new Map(),
      })
    ).toBe("unclassified");
  });

  it("cuota 0 exclusion is line-level only — category slug unchanged without override", () => {
    expect(
      countsTowardCcExpenseGastosMes("supermarket", {
        installment_flag: 1,
        nro_cuota_current: 0,
      })
    ).toBe(false);
    expect(
      resolveCcExpenseCategorySlug({
        statementLineId: 99,
        accountId: 15,
        merchantKey: "SHOP",
        purchaseKey: "installment-h:15:2025-04-01:6:SHOP",
        lineOverrides: new Map(),
        merchantRules: new Map(),
        uniquePurchases: new Map(),
      })
    ).toBe("unclassified");
  });

  it("marks cancelled installment purchase as no_cuenta when no explicit override exists", () => {
    const master = db
      .prepare(`SELECT id FROM accounts WHERE notes = 'credit_card_master|santander|vitest-fixture' LIMIT 1`)
      .get() as { id: number } | undefined;
    if (!master) return;

    db.prepare(
      `INSERT INTO cc_installment_purchases (
         account_id, card_group, canonical_row_id, dedupe_key, parser_row_id_sample, source_pdf_sample,
         purchase_date, total_amount_clp, cuotas_totales, merchant, description_merged, matched_baseline_purchase_id, source
       ) VALUES (?, 'A', 'cat-cancelled-1', NULL, NULL, NULL, '2025-02-07', 54990, 6, 'MP MERCADO LIBRE', 'MP MERCADO LIBRE', NULL, 'pdf')`
    ).run(master.id);
    const pid = (
      db.prepare(
        `SELECT id FROM cc_installment_purchases WHERE account_id = ? AND canonical_row_id = 'cat-cancelled-1'`
      ).get(master.id) as { id: number } | undefined
    )?.id;
    if (!pid) return;

    db.prepare(
      `INSERT INTO cc_statements (account_id, card_group, source_pdf, statement_date, period_from, period_to)
       VALUES (?, 'A', 'cat-cancelled-note.pdf', '25/03/2025', '24/02/2025', '25/03/2025')`
    ).run(master.id);
    const sid = (db.prepare(`SELECT last_insert_rowid() AS id`).get() as { id: number }).id;
    try {
      db.prepare(
        `INSERT INTO cc_statement_lines (statement_id, merchant, description_merged, amount_clp, installment_flag, transaction_date)
         VALUES (?, 'NOTA DE CREDITO', 'SANTIAGO | NOTA DE CREDITO', -54990, 0, '2025-03-10')`
      ).run(sid);

      const resolved = resolveCcExpenseCategorySlug({
        statementLineId: 1,
        accountId: master.id,
        merchantKey: "MP MERCADO LIBRE",
        purchaseKey: `installment:${pid}`,
        lineOverrides: new Map(),
        merchantRules: new Map(),
        uniquePurchases: new Map(),
      });
      expect(resolved).toBe("no_cuenta");

      const resolvedH = resolveCcExpenseCategorySlug({
        statementLineId: 1,
        accountId: master.id,
        merchantKey: "MP MERCADO LIBRE",
        purchaseKey: `installment-h:${master.id}:2025-02-07:6:MP MERCADO LIBRE`,
        lineOverrides: new Map(),
        merchantRules: new Map(),
        uniquePurchases: new Map(),
      });
      expect(resolvedH).toBe("no_cuenta");
    } finally {
      db.prepare(`DELETE FROM cc_statement_lines WHERE statement_id = ?`).run(sid);
      db.prepare(`DELETE FROM cc_statements WHERE id = ?`).run(sid);
      db.prepare(`DELETE FROM cc_installment_payments WHERE purchase_id = ?`).run(pid);
      db.prepare(`DELETE FROM cc_installment_purchases WHERE id = ?`).run(pid);
    }
  });

  it("categoryUniqueForExpenseLine is true for generic transfers without persisted row", () => {
    expect(
      categoryUniqueForExpenseLine(
        15,
        "checking-mv:99",
        "TRANSF. INTERNET A OTRO BANCOS",
        new Map(),
        new Set()
      )
    ).toBe(true);
  });

  it("can enable unique purchase mode before a category is chosen", () => {
    const payload = buildFlowsCreditCardExpensesPayload();
    const allowed = new Set(listCreditCardMasterAccountIds());
    const line = payload.lines.find(
      (ln) => ln.amount_clp > 0 && ln.statement_line_id > 0 && allowed.has(ln.account_id)
    );
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
    const allowed = new Set(listCreditCardMasterAccountIds());
    const line = payload.lines.find(
      (ln) => ln.amount_clp > 0 && ln.statement_line_id > 0 && !!ln.merchant && allowed.has(ln.account_id)
    );
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
        ln.purchase_on != null &&
        ln.category_slug !== "no_cuenta" &&
        !isAdditionalCardExpenseLine(ln.origin_card_last4, ln.primary_card_last4)
    );
    if (!inst) return;

    const purchaseKey = resolveCcExpensePurchaseKey(inst.statement_line_id);
    expect(purchaseKey).toMatch(/^installment-(h|pr):/);

    const cuotaLineIds = listStatementLineIdsForPurchaseKey(
      inst.statement_line_id,
      purchaseKey
    ).filter((lineId) => {
      const ln = payload.lines.find((l) => l.statement_line_id === lineId);
      if (!ln) return false;
      return !isAdditionalCardExpenseLine(ln.origin_card_last4, ln.primary_card_last4);
    });
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

    const stale = db
      .prepare(
        `SELECT id FROM cc_installment_purchases
         WHERE account_id = ? AND merchant = 'TEST_MANUAL_CC_CONSOLIDATED_CAT'`
      )
      .all(master.id) as { id: number }[];
    for (const row of stale) {
      db.prepare(`DELETE FROM cc_installment_payments WHERE purchase_id = ?`).run(row.id);
      db.prepare(`DELETE FROM cc_installment_purchases WHERE id = ?`).run(row.id);
    }

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
