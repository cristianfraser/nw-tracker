import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import {
  NO_CUENTA_CC_EXPENSE_SLUG,
  assignCcExpenseLineCategory,
  countsTowardCcExpenseGastosMes,
  getCcExpenseCategoryBySlug,
  resolveCcExpensePurchaseKey,
} from "./ccExpenseCategories.js";
import { listCreditCardGroupMasterAccountIds, listCreditCardMasterAccountIds } from "./creditCardTree.js";
import { effectiveCcExpenseLineAmountClp } from "./ccExpenseAmountClp.js";
import { db } from "./db.js";
import { flowCcExpenseLineFingerprint } from "./ccExpenseLineDedupe.js";
import {
  buildFlowsCreditCardExpensesPayload,
  resolveExpenseMonth,
} from "./flowsCreditCardExpenses.js";
import { gastosSumMonthForLine, lineCountsTowardGastosSum } from "./ccExpensePeriodMonth.js";
import { hasSplittableMortgageExpenseDepositLink } from "./expenseDepositLinks.js";
import { getVitestSantanderCcMasterAccountId } from "./test/vitestDbSeed.js";

describe("effectiveCcExpenseLineAmountClp", () => {
  it("uses valor_cuota_mensual_clp for installment lines", () => {
    expect(
      effectiveCcExpenseLineAmountClp(
        {
          installment_flag: 1,
          amount_clp: 881_134,
          amount_usd: null,
          valor_cuota_mensual_clp: 73_428,
          valor_cuota_mensual_usd: null,
        },
        "2025-04-22"
      )
    ).toBe(73_428);
  });

  it("uses amount_clp for revolving lines", () => {
    expect(
      effectiveCcExpenseLineAmountClp(
        {
          installment_flag: 0,
          amount_clp: -394_140,
          amount_usd: null,
          valor_cuota_mensual_clp: null,
          valor_cuota_mensual_usd: null,
        },
        "2025-04-22"
      )
    ).toBe(-394_140);
  });
});

describe("resolveExpenseMonth", () => {
  it("prefers purchase date over statement close for one-shot charges", () => {
    expect(resolveExpenseMonth("2025-02-10", "2025-04-22", "2025-04")).toBe("2025-02");
  });

  it("uses billing month for installment cuotas", () => {
    expect(
      resolveExpenseMonth("2025-02-27", "2025-07-24", "2025-07", { installment: true })
    ).toBe("2025-07");
  });
});

describe("flowsCreditCardExpenses", () => {
  const SRC_ADDITIONAL_FIXTURE = "import:web-paste|vitest-flows-additional-card";

  function cleanupAdditionalFixture(): void {
    db.prepare(
      `DELETE FROM cc_statement_lines WHERE statement_id IN (
         SELECT id FROM cc_statements WHERE source_pdf = ?
       )`
    ).run(SRC_ADDITIONAL_FIXTURE);
    db.prepare(`DELETE FROM cc_statements WHERE source_pdf = ?`).run(SRC_ADDITIONAL_FIXTURE);
    // Unique purchase rows (and notes) are keyed by purchase_key; delete any that reference our parser row ids.
    db.prepare(
      `DELETE FROM cc_expense_purchase_notes
       WHERE purchase_key LIKE 'line-pr:vitest-addl-%'`
    ).run();
    db.prepare(
      `DELETE FROM cc_expense_unique_purchases
       WHERE purchase_key LIKE 'line-pr:vitest-addl-%'`
    ).run();
  }

  afterEach(() => cleanupAdditionalFixture());

  it("listCreditCardMasterAccountIds drives the gastos payload", () => {
    const payload = buildFlowsCreditCardExpensesPayload();
    const allowed = new Set(listCreditCardMasterAccountIds());
    for (const id of payload.account_ids) {
      expect(allowed.has(id)).toBe(true);
    }
    for (const ln of payload.lines) {
      if (ln.source !== "cc") continue;
      expect(allowed.has(ln.account_id)).toBe(true);
    }
  });

  it("shows one installment purchase total per contract in compras month (feb 2025 ROCA)", () => {
    const payload = buildFlowsCreditCardExpensesPayload();
    const rocaTotals = payload.lines.filter(
      (ln) =>
        ln.line_role === "installment_purchase_total" &&
        ln.purchase_month === "2025-02" &&
        ln.merchant_key.includes("ROCA")
    );
    if (rocaTotals.length === 0) return;
    expect(rocaTotals).toHaveLength(1);
    expect(rocaTotals[0]?.amount_clp).toBe(881_134);
  });

  it("includes 4242 purchase lines when statement data exists", () => {
    const id4242 = (
      db
        .prepare(`SELECT id FROM accounts WHERE notes = 'credit_card_master|santander|4242'`)
        .get() as { id: number } | undefined
    )?.id;
    if (!id4242) return;

    const raw = (
      db
        .prepare(
          `SELECT COUNT(*) AS c FROM cc_statement_lines l
           JOIN cc_statements s ON s.id = l.statement_id WHERE s.account_id = ?`
        )
        .get(id4242) as { c: number }
    ).c;
    if (raw === 0) return;

    const payload = buildFlowsCreditCardExpensesPayload();
    expect(payload.account_ids).toContain(id4242);
    const cc4242 = payload.lines.filter(
      (ln) => ln.source === "cc" && ln.account_id === id4242 && ln.amount_clp > 0
    );
    expect(cc4242.length).toBeGreaterThan(0);
  });

  it("auto-tags adicional-card lines as no_cuenta + unique in the payload", () => {
    const accountId = getVitestSantanderCcMasterAccountId();
    if (accountId == null) return;
    const parserRowId = `vitest-addl-${randomUUID().replace(/-/g, "").slice(0, 12)}`;

    const stmt = db
      .prepare(
        `INSERT INTO cc_statements (
           account_id, card_group, source_pdf, statement_date, period_from, period_to,
           card_last4, layout, currency
         ) VALUES (?, 'santander', ?, '20/05/2026', '01/05/2026', '19/05/2026', '4242', 'compact', 'clp')`
      )
      .run(accountId, SRC_ADDITIONAL_FIXTURE);
    const statementId = Number(stmt.lastInsertRowid);

    const line = db
      .prepare(
        `INSERT INTO cc_statement_lines (
           statement_id, transaction_date, merchant, amount_clp, installment_flag,
           parser_row_id, origin_card_last4, dedupe_key
         ) VALUES (?, '19/05/2026', 'Additional card payload fixture', 12345, 0, ?, '3670', ?)`
      )
      .run(statementId, parserRowId, `vitest-addl-dedupe-${parserRowId}`);
    const lineId = Number(line.lastInsertRowid);

    const payload = buildFlowsCreditCardExpensesPayload();
    const found = payload.lines.find((ln) => ln.source === "cc" && ln.statement_line_id === lineId);
    expect(found).toBeDefined();
    expect(found!.category_slug).toBe(NO_CUENTA_CC_EXPENSE_SLUG);
    expect(found!.category_unique).toBe(true);
    expect(found!.origin_card_last4).toBe("3670");
    expect(found!.primary_card_last4).toBe("4242");
  });

  it("does not force additional-card no_cuenta when the user cleared unique category", () => {
    const accountId = getVitestSantanderCcMasterAccountId();
    if (accountId == null) return;
    const parserRowId = `vitest-addl-${randomUUID().replace(/-/g, "").slice(0, 12)}`;

    const stmt = db
      .prepare(
        `INSERT INTO cc_statements (
           account_id, card_group, source_pdf, statement_date, period_from, period_to,
           card_last4, layout, currency
         ) VALUES (?, 'santander', ?, '20/05/2026', '01/05/2026', '19/05/2026', '4242', 'compact', 'clp')`
      )
      .run(accountId, SRC_ADDITIONAL_FIXTURE);
    const statementId = Number(stmt.lastInsertRowid);

    const line = db
      .prepare(
        `INSERT INTO cc_statement_lines (
           statement_id, transaction_date, merchant, amount_clp, installment_flag,
           parser_row_id, origin_card_last4, dedupe_key
         ) VALUES (?, '19/05/2026', 'Additional card cleared fixture', 22222, 0, ?, '3670', ?)`
      )
      .run(statementId, parserRowId, `vitest-addl-dedupe-${parserRowId}`);
    const lineId = Number(line.lastInsertRowid);

    const purchaseKey = resolveCcExpensePurchaseKey(lineId);
    const noCuentaId = getCcExpenseCategoryBySlug(NO_CUENTA_CC_EXPENSE_SLUG)?.id;
    expect(noCuentaId).toBeTruthy();

    // Simulate user-cleared unique: category_id NULL exists in DB at load.
    db.prepare(
      `INSERT INTO cc_expense_unique_purchases (account_id, purchase_key, category_id)
       VALUES (?, ?, NULL)
       ON CONFLICT(account_id, purchase_key) DO UPDATE SET category_id = NULL`
    ).run(accountId, purchaseKey);

    const payload = buildFlowsCreditCardExpensesPayload();
    const found = payload.lines.find((ln) => ln.source === "cc" && ln.statement_line_id === lineId);
    expect(found).toBeDefined();

    // We should not override to no_cuenta when the user explicitly cleared unique.
    expect(found!.category_slug).not.toBe(NO_CUENTA_CC_EXPENSE_SLUG);
  });

  it("never auto-tags installment contracts as no_cuenta for adicional cuotas", () => {
    const payload = buildFlowsCreditCardExpensesPayload();
    const adicionalInstallment = payload.lines.find(
      (ln) =>
        ln.source === "cc" &&
        ln.installment_flag === 1 &&
        ln.origin_card_last4 != null &&
        ln.primary_card_last4 != null &&
        ln.origin_card_last4 !== ln.primary_card_last4
    );
    if (!adicionalInstallment) return;
    expect(adicionalInstallment.category_slug).not.toBe(NO_CUENTA_CC_EXPENSE_SLUG);
  });

  it("keeps user unique category on installment contract when an adicional cuota exists", () => {
    const payload = buildFlowsCreditCardExpensesPayload();
    const titularCuota = payload.lines.find(
      (ln) =>
        ln.source === "cc" &&
        ln.installment_flag === 1 &&
        ln.merchant_key.includes("ROCA") &&
        ln.nro_cuota_current === 1 &&
        ln.origin_card_last4 === ln.primary_card_last4
    );
    if (!titularCuota) return;

    const purchaseKey = resolveCcExpensePurchaseKey(titularCuota.statement_line_id);
    expect(purchaseKey).toMatch(/^installment-h:/);

    assignCcExpenseLineCategory({
      statementLineId: titularCuota.statement_line_id,
      unique: true,
      categorySlug: "others",
    });

    const after = buildFlowsCreditCardExpensesPayload();
    const contractLines = after.lines.filter(
      (ln) =>
        ln.source === "cc" &&
        ln.merchant_key.includes("ROCA") &&
        (ln.line_role === "installment_cuota" || ln.line_role === "installment_purchase_total")
    );
    expect(contractLines.length).toBeGreaterThan(0);
    for (const ln of contractLines) {
      expect(ln.category_slug).toBe("others");
    }

    const row = db
      .prepare(
        `SELECT c.slug FROM cc_expense_unique_purchases up
         JOIN cc_expense_categories c ON c.id = up.category_id
         WHERE up.account_id = ? AND up.purchase_key = ?`
      )
      .get(titularCuota.account_id, purchaseKey) as { slug: string } | undefined;
    expect(row?.slug).toBe("others");
  });

  it("clear_category on installment contract stays unclassified after rebuild", () => {
    const payload = buildFlowsCreditCardExpensesPayload();
    const titularCuota = payload.lines.find(
      (ln) =>
        ln.source === "cc" &&
        ln.installment_flag === 1 &&
        ln.merchant_key.includes("ROCA") &&
        ln.nro_cuota_current === 1 &&
        ln.origin_card_last4 === ln.primary_card_last4
    );
    if (!titularCuota) return;

    assignCcExpenseLineCategory({
      statementLineId: titularCuota.statement_line_id,
      unique: true,
      categorySlug: "others",
    });

    assignCcExpenseLineCategory({
      statementLineId: titularCuota.statement_line_id,
      unique: true,
      clearCategory: true,
    });

    for (let i = 0; i < 2; i++) {
      const after = buildFlowsCreditCardExpensesPayload();
      const contractLines = after.lines.filter(
        (ln) =>
          ln.source === "cc" &&
          ln.merchant_key.includes("ROCA") &&
          (ln.line_role === "installment_cuota" || ln.line_role === "installment_purchase_total")
      );
      expect(contractLines.length).toBeGreaterThan(0);
      for (const ln of contractLines) {
        expect(ln.category_slug).toBe("unclassified");
      }
    }
  });

  it("builds monthly rows with cumulative gastos when statement lines exist", () => {
    const payload = buildFlowsCreditCardExpensesPayload();
    expect(payload.group_slug).toBe("credit_cards");
    if (payload.by_month.length === 0) return;

    const asc = [...payload.by_month].reverse();
    let expected = 0;
    for (const row of asc) {
      expected += row.gastos_mes_clp;
      expect(row.gastos_acumulado_clp).toBe(expected);
      expect(row.period_month).toMatch(/^\d{4}-\d{2}$/);
      expect(row.as_of_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
    expect(payload.chart_monthly.length).toBe(asc.length);
  });

  it("groups installment lines by billing month, not purchase month", () => {
    const payload = buildFlowsCreditCardExpensesPayload();
    const installmentLines = payload.lines.filter(
      (ln) =>
        ln.source === "cc" &&
        ln.installment_flag === 1 &&
        ln.purchase_on != null &&
        ln.purchase_on.startsWith("2025-02") &&
        ln.billing_month !== ln.expense_month
    );
    if (installmentLines.length === 0) return;

    for (const ln of installmentLines) {
      expect(ln.expense_month).toBe(ln.billing_month);
      expect(ln.line_role).toBe("installment_cuota");
    }

    const febPurchaseInstallments = installmentLines.filter((ln) =>
      ln.purchase_on!.startsWith("2025-02")
    );
    const febModalCount = febPurchaseInstallments.filter(
      (ln) => ln.expense_month === "2025-02"
    ).length;
    expect(febModalCount).toBe(0);
  });

  it("does not count installment purchase totals toward gastos in split mode", () => {
    const payload = buildFlowsCreditCardExpensesPayload();
    const totals = payload.lines.filter(
      (ln) => ln.line_role === "installment_purchase_total" && ln.amount_clp > 0
    );
    if (totals.length === 0) return;

    for (const ln of totals) {
      expect(gastosSumMonthForLine(ln, "split")).toBe("");
      const countsCategory = countsTowardCcExpenseGastosMes(ln.category_slug, {
        installment_flag: ln.installment_flag,
        nro_cuota_current: ln.nro_cuota_current,
      });
      expect(lineCountsTowardGastosSum(ln, "split", countsCategory)).toBe(false);
    }
  });

  it("includes checking gastos lines when cuenta corriente is configured", () => {
    const payload = buildFlowsCreditCardExpensesPayload();
    const checking = payload.lines.filter((ln) => ln.source === "checking");
    expect(checking.length).toBeGreaterThan(0);
  });

  it("gastos_mes_clp reflects NOTA DE CREDITO pairing and unmatched adjustments", () => {
    const payload = buildFlowsCreditCardExpensesPayload();
    for (const row of payload.by_month) {
      const monthLines = payload.lines.filter(
        (ln) => gastosSumMonthForLine(ln, "split") === row.period_month
      );
      const sumPositive = monthLines
        .filter((ln) => ln.amount_clp > 0 && ln.nota_credito_role !== "annulled_purchase")
        .reduce((s, ln) => s + ln.amount_clp, 0);
      const sumCounted = monthLines.reduce((s, ln) => {
        if (ln.nota_credito_role === "annulled_purchase" || ln.nota_credito_role === "matched_nota") {
          return s;
        }
        if (ln.nota_credito_role === "unmatched_nota") return s + ln.amount_clp;
        const countsCategory = countsTowardCcExpenseGastosMes(ln.category_slug, {
          installment_flag: ln.installment_flag,
          nro_cuota_current: ln.nro_cuota_current,
        });
        if (ln.amount_clp > 0 && lineCountsTowardGastosSum(ln, "split", countsCategory)) {
          // Mortgage-linked lines contribute only the carrying portion (deuda amortization
          // is tracked separately), matching the production aggregateGastosFromLines logic.
          const link = ln.expense_deposit_link;
          const mortgageSplit = hasSplittableMortgageExpenseDepositLink(link);
          return s + (mortgageSplit ? link.carrying_clp : ln.amount_clp);
        }
        return s;
      }, 0);
      expect(row.gastos_real_mes_clp).toBe(Math.round(sumPositive));
      expect(row.gastos_mes_clp).toBe(Math.round(sumCounted));
    }
  });

  it("annuls APPLE purchase when a matching NOTA DE CREDITO appears later", () => {
    const payload = buildFlowsCreditCardExpensesPayload();
    const apple = payload.lines.find(
      (ln) => ln.merchant === "APPLE.COM CL" && ln.nota_credito_role === "annulled_purchase"
    );
    const nota = payload.lines.find(
      (ln) => ln.merchant === "NOTA DE CREDITO" && ln.nota_credito_role === "matched_nota"
    );
    if (!apple || !nota) return;

    expect(apple.nota_credito_role).toBe("annulled_purchase");
    expect(nota.nota_credito_role).toBe("matched_nota");

    const novCountedIds = payload.lines
      .filter((ln) => {
        if (ln.expense_month !== "2024-11") return false;
        if (ln.nota_credito_role === "annulled_purchase" || ln.nota_credito_role === "matched_nota") {
          return false;
        }
        if (ln.nota_credito_role === "unmatched_nota") return true;
        return (
          ln.amount_clp > 0 &&
          countsTowardCcExpenseGastosMes(ln.category_slug, {
            installment_flag: ln.installment_flag,
            nro_cuota_current: ln.nro_cuota_current,
          })
        );
      })
      .map((ln) => ln.statement_line_id);
    expect(novCountedIds).not.toContain(apple.statement_line_id);

    const dec = payload.by_month.find((m) => m.period_month === "2024-12");
    expect(dec).toBeDefined();
    const decAbonosFromLines = payload.lines
      .filter((ln) => ln.expense_month === "2024-12" && ln.amount_clp < 0)
      .filter((ln) => ln.nota_credito_role !== "matched_nota" && ln.nota_credito_role !== "unmatched_nota")
      .reduce((s, ln) => s + ln.amount_clp, 0);
    expect(dec!.abonos_mes_clp).toBe(Math.round(decAbonosFromLines));
  });

  it("includes USD-only statement lines converted to CLP", () => {
    const accountIds = listCreditCardMasterAccountIds();
    if (accountIds.length === 0) return;
    const ph = accountIds.map(() => "?").join(",");
    const usdOnlyIds = db
      .prepare(
        `SELECT l.id FROM cc_statement_lines l
         JOIN cc_statements s ON s.id = l.statement_id
         WHERE s.account_id IN (${ph})
           AND (l.amount_usd IS NOT NULL AND l.amount_usd != 0)
           AND (l.amount_clp IS NULL OR l.amount_clp = 0)
           AND NOT (l.installment_flag = 1 AND l.valor_cuota_mensual_clp IS NOT NULL AND l.valor_cuota_mensual_clp != 0)`
      )
      .all(...accountIds) as { id: number }[];
    if (usdOnlyIds.length === 0) return;

    const payload = buildFlowsCreditCardExpensesPayload();
    const included = new Set(payload.lines.map((ln) => ln.statement_line_id));
    const matched = usdOnlyIds.filter((r) => included.has(r.id));
    expect(matched.length).toBeGreaterThan(usdOnlyIds.length * 0.5);
    expect(payload.total_clp).toBeGreaterThan(0);
    const usdIncludedClp = payload.lines
      .filter(
        (ln) =>
          ln.amount_clp > 0 &&
          usdOnlyIds.some((r) => r.id === ln.statement_line_id)
      )
      .reduce((s, ln) => s + ln.amount_clp, 0);
    expect(usdIncludedClp).toBeGreaterThan(0);
  });

  it("installment lines in payload use cuota amount, not full purchase", () => {
    const payload = buildFlowsCreditCardExpensesPayload();
    const inst = payload.lines.find(
      (ln) =>
        ln.installment_flag === 1 &&
        ln.merchant?.includes("ROCA") &&
        ln.nro_cuota_current != null &&
        ln.nro_cuota_current >= 2
    );
    if (!inst) return;
    expect(inst.amount_clp).toBeLessThan(200_000);
  });

  it("has no duplicate gastos fingerprints on credit card lines", () => {
    const payload = buildFlowsCreditCardExpensesPayload();
    const seen = new Set<string>();
    for (const ln of payload.lines.filter(
      (l) =>
        l.source === "cc" &&
        l.amount_clp > 0 &&
        l.line_role !== "installment_purchase_total"
    )) {
      const fp = flowCcExpenseLineFingerprint(ln);
      expect(seen.has(fp)).toBe(false);
      seen.add(fp);
    }
  });
});
