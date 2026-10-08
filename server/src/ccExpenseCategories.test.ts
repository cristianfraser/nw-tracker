import { afterAll, describe, expect, it } from "vitest";
import { isAdditionalCardExpenseLine } from "./ccAdditionalCardExpenseMatch.js";
import {
  assignCcExpenseCategoryForManualLedgerInstallmentPurchase,
  assignCcExpenseLineCategory,
  BILLS_CC_EXPENSE_SLUG,
  categoryUniqueForExpenseLine,
  countsTowardCcExpenseGastosMes,
  darkenHexColor,
  getCcExpenseCategoryBySlug,
  installmentLedgerTotalForStatementLine,
  listCcExpenseCategories,
  loadCcStatementLineExpenseCtx,
  listStatementLineIdsForPurchaseKey,
  loadCcExpenseCategoryMaps,
  normalizeCcExpenseMerchantKey,
  REAL_ESTATE_AMORTIZATION_CC_EXPENSE_SLUG,
  resolveCcExpenseCategorySlug,
  resolveCcExpensePurchaseKey,
  resolveMerchantCategorySlug,
  isGenericTransferMerchantKey,
  registerGenericUniquePurchaseMode,
} from "./ccExpenseCategories.js";
import { listCreditCardGroupMasterAccountIds, listCreditCardMasterAccountIds } from "./creditCardTree.js";
import { db } from "./db.js";
import { getVitestSantanderCcMasterAccountId, wipeVitestCcFixtureData } from "./test/vitestDbSeed.js";
import { buildFlowsExpensesPayload } from "./flowsExpenses.js";
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

  it("unique purchase mode without category blocks merchant rule", () => {
    expect(
      resolveCcExpenseCategorySlug({
        statementLineId: 5,
        accountId: 15,
        merchantKey: "TEST",
        purchaseKey: "line-pr:abc",
        lineOverrides: new Map(),
        merchantRules: new Map([["15|TEST", "supermarket"]]),
        uniquePurchases: new Map(),
        uniquePurchaseModeKeys: new Set(["15|line-pr:abc"]),
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
    expect(isGenericTransferMerchantKey("TRASPASO A DEUDA NACIONAL")).toBe(true);
    expect(isGenericTransferMerchantKey("1234567890 CARGO MERCADO CAPITALES")).toBe(true);
    expect(isGenericTransferMerchantKey("CARGO MERCADO CAPITALES")).toBe(true);
    expect(isGenericTransferMerchantKey("TRANSFERENCIA A JUAN PEREZ")).toBe(false);
    expect(isGenericTransferMerchantKey("TRANSF 123456")).toBe(false);
    expect(isGenericTransferMerchantKey("TRANSF. A PEDRO PAINEL GAJARDO")).toBe(false);
    expect(isGenericTransferMerchantKey("0768106274 TRANSF A FINTUAL")).toBe(false);
  });

  it("assigns no_cuenta to traspaso deuda nacional", () => {
    expect(
      resolveCcExpenseCategorySlug({
        statementLineId: 1,
        accountId: 15,
        merchantKey: "TRASPASO A DEUDA NACIONAL",
        purchaseKey: "one:1",
        lineOverrides: new Map(),
        merchantRules: new Map(),
        uniquePurchases: new Map(),
      })
    ).toBe("no_cuenta");
  });

  it("generic Único auto-registration skips traspaso deuda so no_cuenta still derives", () => {
    const accountId = getVitestSantanderCcMasterAccountId();
    if (accountId == null) return;
    const purchaseKey = "line-pr:vitest-traspaso-register";
    const modeKeys = new Set<string>();
    try {
      registerGenericUniquePurchaseMode(
        accountId,
        purchaseKey,
        "TRASPASO A DEUDA NACIONAL",
        modeKeys
      );
      expect(modeKeys.size).toBe(0);
      expect(
        db
          .prepare(
            `SELECT 1 AS o FROM cc_expense_unique_purchases WHERE account_id = ? AND purchase_key = ?`
          )
          .get(accountId, purchaseKey)
      ).toBeUndefined();
      // Without the shadow row, resolution reaches the derived traspaso branch.
      expect(
        resolveCcExpenseCategorySlug({
          statementLineId: 1,
          accountId,
          merchantKey: "TRASPASO A DEUDA NACIONAL",
          purchaseKey,
          lineOverrides: new Map(),
          merchantRules: new Map(),
          uniquePurchases: new Map(),
          uniquePurchaseModeKeys: modeKeys,
        })
      ).toBe("no_cuenta");

      // Other generic transfer merchants keep the Único-mode registration.
      registerGenericUniquePurchaseMode(accountId, purchaseKey, "TRANSFERENCIA", modeKeys);
      expect(modeKeys.has(`${accountId}|${purchaseKey}`)).toBe(true);
      expect(
        db
          .prepare(
            `SELECT 1 AS o FROM cc_expense_unique_purchases WHERE account_id = ? AND purchase_key = ?`
          )
          .get(accountId, purchaseKey)
      ).toBeTruthy();
    } finally {
      db.prepare(
        `DELETE FROM cc_expense_unique_purchases WHERE account_id = ? AND purchase_key = ?`
      ).run(accountId, purchaseKey);
    }
  });

  it("explicit user clear on a traspaso line still resolves unclassified", () => {
    // A NULL-category unique row written by the clear path loads into uniquePurchaseModeKeys,
    // which outranks the derived traspaso branch.
    expect(
      resolveCcExpenseCategorySlug({
        statementLineId: 1,
        accountId: 15,
        merchantKey: "TRASPASO A DEUDA NACIONAL",
        purchaseKey: "one:1",
        lineOverrides: new Map(),
        merchantRules: new Map(),
        uniquePurchases: new Map(),
        uniquePurchaseModeKeys: new Set(["15|one:1"]),
      })
    ).toBe("unclassified");
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
    const payload = buildFlowsExpensesPayload();
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

    const after = buildFlowsExpensesPayload();
    const updated = after.lines.find((ln) => ln.statement_line_id === line.statement_line_id);
    expect(updated?.category_unique).toBe(true);
    expect(updated?.category_slug).toBe("unclassified");
  });

  /**
 * Deterministic merchant-propagation fixture: three same-merchant lines on the isolated
 * vitest CC master. Earlier versions picked arbitrary real lines from the payload, which
 * broke as the copied dev data (and rows persisted by prior test runs) evolved.
 */
function createMerchantPropagationFixture(tag: string): {
  accountId: number;
  merchant: string;
  lineIds: number[];
  cleanup: () => void;
} | null {
  const accountId = getVitestSantanderCcMasterAccountId();
  if (accountId == null) return null;
  const merchant = `VITEST PROPAGATE ${tag.toUpperCase()}`;
  const src = `vitest-merchant-${tag}.pdf`;
  const stmt = db
    .prepare(
      `INSERT INTO cc_statements (
         account_id, card_group, source_pdf, statement_date, period_from, period_to,
         card_last4, layout, currency
       ) VALUES (?, 'santander', ?, '20/05/2026', '01/05/2026', '19/05/2026', '0000', 'compact', 'clp')`
    )
    .run(accountId, src);
  const statementId = Number(stmt.lastInsertRowid);
  const lineIds: number[] = [];
  for (const [i, amount] of [11_990, 22_990, 33_990].entries()) {
    const r = db
      .prepare(
        `INSERT INTO cc_statement_lines (
           statement_id, transaction_date, merchant, amount_clp, installment_flag, dedupe_key
         ) VALUES (?, ?, ?, ?, 0, ?)`
      )
      .run(statementId, `0${i + 2}/05/2026`, merchant, amount, `vitest-merchant-${tag}-${i}`);
    lineIds.push(Number(r.lastInsertRowid));
  }
  const cleanup = () => {
    const merchantKey = normalizeCcExpenseMerchantKey(merchant);
    // Resolve purchase keys BEFORE deleting the lines (the resolver reads them).
    const purchaseKeys = lineIds.map((id) => resolveCcExpensePurchaseKey(id));
    for (const id of lineIds) {
      db.prepare(`DELETE FROM cc_expense_line_categories WHERE statement_line_id = ?`).run(id);
    }
    for (const pk of purchaseKeys) {
      db.prepare(
        `DELETE FROM cc_expense_unique_purchases WHERE account_id = ? AND purchase_key = ?`
      ).run(accountId, pk);
    }
    db.prepare(`DELETE FROM cc_expense_merchant_categories WHERE account_id = ? AND merchant_key = ?`).run(
      accountId,
      merchantKey
    );
    db.prepare(`DELETE FROM cc_statement_lines WHERE statement_id = ?`).run(statementId);
    db.prepare(`DELETE FROM cc_statements WHERE id = ?`).run(statementId);
  };
  return { accountId, merchant, lineIds, cleanup };
}

  it("merchant assignment applies to same comercio when not marked unique", () => {
    const fx = createMerchantPropagationFixture("assign");
    if (!fx) return;
    try {
      const merchantKey = normalizeCcExpenseMerchantKey(fx.merchant);
      const [target, ...peerIds] = fx.lineIds;

      assignCcExpenseLineCategory({
        statementLineId: target!,
        unique: false,
        categorySlug: "supermarket",
      });

      const after = buildFlowsExpensesPayload();
      const sameMerchant = after.lines.filter(
        (ln) => ln.account_id === fx.accountId && ln.merchant_key === merchantKey
      );
      expect(sameMerchant.length).toBe(3);
      for (const ln of sameMerchant) {
        expect(ln.category_slug).toBe("supermarket");
        expect(ln.category_unique).toBe(false);
      }

      assignCcExpenseLineCategory({
        statementLineId: target!,
        unique: true,
        categorySlug: "others",
      });

      const uniqueAfter = buildFlowsExpensesPayload();
      const onlyLine = uniqueAfter.lines.find((ln) => ln.statement_line_id === target);
      expect(onlyLine?.category_slug).toBe("others");
      expect(onlyLine?.category_unique).toBe(true);

      for (const peerId of peerIds) {
        const peer = uniqueAfter.lines.find((ln) => ln.statement_line_id === peerId);
        expect(peer?.category_slug).toBe("supermarket");
        expect(peer?.category_unique).toBe(false);
      }
    } finally {
      fx.cleanup();
    }
  });

  it("clear_category on unique purchase keeps Único, stays unclassified, and does not clear merchant rule", () => {
    const fx = createMerchantPropagationFixture("clear");
    if (!fx) return;
    try {
      const merchantKey = normalizeCcExpenseMerchantKey(fx.merchant);
      const [target, ...peerIds] = fx.lineIds;

      assignCcExpenseLineCategory({
        statementLineId: target!,
        unique: false,
        categorySlug: "supermarket",
      });

      assignCcExpenseLineCategory({
        statementLineId: target!,
        unique: true,
        categorySlug: "fun",
      });

      const cleared = assignCcExpenseLineCategory({
        statementLineId: target!,
        unique: true,
        clearCategory: true,
      });
      expect(cleared.category_slug).toBe("unclassified");
      expect(cleared.unique).toBe(true);

      const after = buildFlowsExpensesPayload();
      const updated = after.lines.find((ln) => ln.statement_line_id === target);
      expect(updated?.category_unique).toBe(true);
      expect(updated?.category_slug).toBe("unclassified");

      // Merchant rule survives the unique-line clear; peers keep supermarket.
      const { merchantRules } = loadCcExpenseCategoryMaps([fx.accountId]);
      expect(resolveMerchantCategorySlug(fx.accountId, merchantKey, merchantRules)).toBe(
        "supermarket"
      );
      for (const peerId of peerIds) {
        const peer = after.lines.find((ln) => ln.statement_line_id === peerId);
        expect(peer?.category_slug).toBe("supermarket");
        expect(peer?.category_unique).toBe(false);
      }
    } finally {
      fx.cleanup();
    }
  });

  it("clear_category on non-unique purchase removes merchant rule", () => {
    const payload = buildFlowsExpensesPayload();
    const allowed = new Set(listCreditCardMasterAccountIds());
    const line = payload.lines.find(
      (ln) => ln.amount_clp > 0 && ln.statement_line_id > 0 && !!ln.merchant && allowed.has(ln.account_id)
    );
    if (!line) return;

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

    const afterMerchantClear = buildFlowsExpensesPayload();
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
    const payload = buildFlowsExpensesPayload();
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

    const afterCheck = buildFlowsExpensesPayload();
    for (const lineId of cuotaLineIds) {
      const ln = afterCheck.lines.find((l) => l.statement_line_id === lineId);
      expect(ln?.category_unique).toBe(true);
    }

    assignCcExpenseLineCategory({
      statementLineId: inst.statement_line_id,
      unique: true,
      categorySlug: "fun",
    });

    const afterCategory = buildFlowsExpensesPayload();
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

    const afterUncheck = buildFlowsExpensesPayload();
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

  it("darkens bills chart color for real_estate_amortization category", () => {
    const bills = getCcExpenseCategoryBySlug(BILLS_CC_EXPENSE_SLUG);
    expect(bills).not.toBeNull();
    const categories = listCcExpenseCategories();
    const amort = categories.find((c) => c.slug === REAL_ESTATE_AMORTIZATION_CC_EXPENSE_SLUG);
    expect(amort).toBeDefined();
    expect(amort!.chart_color).toBe(darkenHexColor(bills!.chart_color));
    expect(amort!.chart_color).not.toBe(bills!.chart_color);
  });
});

describe("installment statement lines resolve their plan total for the purchase key", () => {
  it("same-identity twin plans: payment row wins, printed cuota disambiguates, else legacy key", () => {
    const accountId = getVitestSantanderCcMasterAccountId();
    expect(accountId).not.toBeNull();
    if (accountId == null) return;
    const tag = "vitest-twin-total";
    const merchant = "RECAUDACION VITEST TWIN";
    const insPlan = db.prepare(
      `INSERT INTO cc_installment_purchases (
         account_id, card_group, canonical_row_id, purchase_date, total_amount_clp, cuotas_totales,
         merchant, description_merged, source
       ) VALUES (?, 'A', ?, ?, ?, 3, ?, ?, 'pdf')`
    );
    // Twins: same account/date/cuotas/merchant, different totals (a facturado paid as two POS
    // transactions). A lone plan on another date checks the plain identity tier.
    const planA = Number(insPlan.run(accountId, `${tag}-a`, "2026-06-30", 1_200_000, merchant, merchant).lastInsertRowid);
    const planB = Number(insPlan.run(accountId, `${tag}-b`, "2026-06-30", 1_267_034, merchant, merchant).lastInsertRowid);
    const planC = Number(insPlan.run(accountId, `${tag}-c`, "2026-07-01", 500_000, merchant, merchant).lastInsertRowid);
    db.prepare(
      `INSERT INTO cc_statements (account_id, card_group, source_pdf, statement_date, period_from, period_to)
       VALUES (?, 'A', ?, '25/08/2026', '24/07/2026', '25/08/2026')`
    ).run(accountId, `${tag}.pdf`);
    const sid = (db.prepare(`SELECT last_insert_rowid() AS id`).get() as { id: number }).id;
    const insLine = db.prepare(
      `INSERT INTO cc_statement_lines (
         statement_id, merchant, description_merged, amount_clp, installment_flag,
         nro_cuota_current, nro_cuota_total, valor_cuota_mensual_clp, transaction_date, parser_row_id
       ) VALUES (?, ?, ?, ?, 1, 1, 3, ?, ?, ?)`
    );
    const line = (amount: number, valor: number | null, txDate: string, prid: string) =>
      Number(insLine.run(sid, merchant, merchant, amount, valor, txDate, prid).lastInsertRowid);
    try {
      // Tier 1: the line's own payment row names plan A.
      const viaPayment = line(1_200_000, 400_000, "30/06/2026", `${tag}-prid-a`);
      db.prepare(
        `INSERT INTO cc_installment_payments (purchase_id, pay_by_date, amount_clp, cuota_current, cuota_total, parser_row_id, statement_period_month)
         VALUES (?, '2026-09-10', 400000, 1, 3, ?, '2026-08')`
      ).run(planA, `${tag}-prid-a`);
      // Tier 3: no payment row, but the printed cuota (1.xxx.xxx ÷ 3) singles out plan B.
      const viaCuota = line(1_267_034, 422_345, "30/06/2026", `${tag}-prid-b`);
      // Twins with neither: legacy no-total key, never a guess.
      const ambiguous = line(1_200_000, null, "30/06/2026", `${tag}-prid-x`);
      // Tier 2: a lone plan resolves by identity alone.
      const lone = line(500_000, null, "01/07/2026", `${tag}-prid-c`);

      expect(resolveCcExpensePurchaseKey(viaPayment)).toBe(
        `installment-h:${accountId}:2026-06-30:3:1200000:${merchant}`
      );
      expect(resolveCcExpensePurchaseKey(viaCuota)).toBe(
        `installment-h:${accountId}:2026-06-30:3:1267034:${merchant}`
      );
      expect(resolveCcExpensePurchaseKey(ambiguous)).toBe(
        `installment-h:${accountId}:2026-06-30:3:${merchant}`
      );
      expect(resolveCcExpensePurchaseKey(lone)).toBe(
        `installment-h:${accountId}:2026-07-01:3:500000:${merchant}`
      );
      // The stamped total agrees with the key on every tier.
      expect(loadCcStatementLineExpenseCtx(viaPayment)?.installment_total_clp).toBe(1_200_000);
      expect(loadCcStatementLineExpenseCtx(viaCuota)?.installment_total_clp).toBe(1_267_034);
      expect(loadCcStatementLineExpenseCtx(ambiguous)?.installment_total_clp).toBeNull();
      expect(loadCcStatementLineExpenseCtx(lone)?.installment_total_clp).toBe(500_000);
      // The flows builder's call shape (ISO date, raw row fields) resolves the same way.
      expect(
        installmentLedgerTotalForStatementLine({
          accountId,
          purchaseDateIso: "2026-06-30",
          cuotasTotales: 3,
          merchant,
          parserRowId: `${tag}-prid-a`,
          valorCuotaMensualClp: 400_000,
        })
      ).toBe(1_200_000);
    } finally {
      db.prepare(`DELETE FROM cc_statement_lines WHERE statement_id = ?`).run(sid);
      db.prepare(`DELETE FROM cc_statements WHERE id = ?`).run(sid);
      for (const pid of [planA, planB, planC]) {
        db.prepare(`DELETE FROM cc_installment_payments WHERE purchase_id = ?`).run(pid);
        db.prepare(`DELETE FROM cc_installment_purchases WHERE id = ?`).run(pid);
      }
    }
  });

  it("twin plans of identical purchases share their total, so identity alone keys them", () => {
    const accountId = getVitestSantanderCcMasterAccountId();
    expect(accountId).not.toBeNull();
    if (accountId == null) return;
    const tag = "vitest-twin-same-total";
    const merchant = "VITEST TWIN SAME TOTAL";
    const insPlan = db.prepare(
      `INSERT INTO cc_installment_purchases (
         account_id, card_group, canonical_row_id, purchase_date, total_amount_clp, cuotas_totales,
         merchant, description_merged, source, twin_index
       ) VALUES (?, 'A', ?, '2025-01-10', 60000, 3, ?, ?, 'pdf', ?)`
    );
    const plans = [0, 1, 2].map((twin) =>
      Number(insPlan.run(accountId, `${tag}-${twin}`, merchant, merchant, twin).lastInsertRowid)
    );
    db.prepare(
      `INSERT INTO cc_statements (account_id, card_group, source_pdf, statement_date, period_from, period_to)
       VALUES (?, 'A', ?, '23/01/2025', '24/12/2024', '23/01/2025')`
    ).run(accountId, `${tag}.pdf`);
    const sid = (db.prepare(`SELECT last_insert_rowid() AS id`).get() as { id: number }).id;
    try {
      // No payment row for this line (a cuota-00 preamble has none): identity alone decides.
      const lineId = Number(
        db
          .prepare(
            `INSERT INTO cc_statement_lines (
               statement_id, merchant, description_merged, amount_clp, installment_flag,
               nro_cuota_current, nro_cuota_total, valor_cuota_mensual_clp, transaction_date, parser_row_id
             ) VALUES (?, ?, ?, 60000, 1, 0, 3, 20000, '10/01/2025', ?)`
          )
          .run(sid, merchant, merchant, `${tag}-prid`).lastInsertRowid
      );
      expect(resolveCcExpensePurchaseKey(lineId)).toBe(
        `installment-h:${accountId}:2025-01-10:3:60000:${merchant}`
      );
      expect(loadCcStatementLineExpenseCtx(lineId)?.installment_total_clp).toBe(60_000);
    } finally {
      db.prepare(`DELETE FROM cc_statement_lines WHERE statement_id = ?`).run(sid);
      db.prepare(`DELETE FROM cc_statements WHERE id = ?`).run(sid);
      for (const pid of plans) {
        db.prepare(`DELETE FROM cc_installment_purchases WHERE id = ?`).run(pid);
      }
    }
  });
});

afterAll(() => {
  wipeVitestCcFixtureData();
});

describe("expense subcategories", () => {
  it("lists the payroll subcategories under «Cuentas y servicios» and top-level categories without a parent", () => {
    const bySlug = new Map(listCcExpenseCategories().map((c) => [c.slug, c]));
    expect(bySlug.get("taxes")?.parent_slug).toBe("bills");
    expect(bySlug.get("pension_fees")?.parent_slug).toBe("bills");
    expect(bySlug.get("bills")?.parent_slug).toBeNull();
    expect(getCcExpenseCategoryBySlug("taxes")).toMatchObject({ slug: "taxes", parent_slug: "bills" });
  });
});
