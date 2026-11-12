import { afterAll, describe, expect, it } from "vitest";
import { db } from "./db.js";
import {
  convertStatementLineToInstallmentPurchase,
  deleteManualCcInstallmentPurchase,
  updateManualCcInstallmentPurchase,
} from "./ccInstallmentManual.js";
import { buildCcExpenseLines, buildFlowsExpenseLines } from "./flowsExpenses.js";
import { debtEventLines, planPurchaseEvents } from "./cards/purchases.js";
import { getCcExpenseCategoryBySlug } from "./ccExpenseCategories.js";
import {
  ensureVitestCreditCardFixtures,
  getVitestSantanderCcMasterAccountId,
  wipeVitestCcFixtureData,
} from "./test/vitestDbSeed.js";

const MERCHANT = "ZZ ROUNDTRIP STORE";

/** What the Expenses page and the owed walk read of this purchase. */
function view(accountId: number, lineId: number) {
  const expense = buildCcExpenseLines([accountId])
    .filter((l) => String(l.merchant ?? "").includes("ROUNDTRIP"))
    .map((l) => ({ id: l.statement_line_id, amount: l.amount_clp, role: l.line_role, category: l.category_slug }));
  const debt = debtEventLines(accountId)
    .filter((l) => l.id === lineId)
    .map((l) => ({ id: l.id, amount: l.amount_clp }));
  const plans = planPurchaseEvents(accountId).filter((p) => p.total_amount_clp === 456_789);
  return { expense, debt, plans: plans.length };
}

describe("convert a card line to cuotas, change the count, remove the plan (bug 17)", () => {
  afterAll(() => wipeVitestCcFixtureData());

  it("is lossless: the line, its category and its debt are back as they were", () => {
    ensureVitestCreditCardFixtures();
    const accountId = getVitestSantanderCcMasterAccountId();
    if (accountId == null) return;
    const suffix = `roundtrip-${Date.now()}`;
    const statementId = Number(
      db
        .prepare(
          `INSERT INTO cc_statements (account_id, card_group, source_pdf, statement_date, period_from, period_to, pay_by,
             card_last4, layout, currency, saldo_anterior, abono, compras_cargos, deuda_total, monto_facturado)
           VALUES (?, 'A', ?, '24/07/2031', '2031-06-25', '2031-07-24', '10/08/2031', '0000', 'compact', 'clp', 0, 0, 0, 0, NULL)`
        )
        .run(accountId, `${suffix}.pdf`).lastInsertRowid
    );
    const lineId = Number(
      db
        .prepare(
          `INSERT INTO cc_statement_lines (statement_id, transaction_date, merchant, amount, installment_flag, dedupe_key, parser_row_id, raw_line)
           VALUES (?, '05/07/2031', ?, 456789, 0, ?, ?, 'raw')`
        )
        .run(statementId, MERCHANT, `dedupe-${suffix}`, suffix).lastInsertRowid
    );
    const cat = getCcExpenseCategoryBySlug("bills")!;
    db.prepare(`INSERT INTO cc_expense_line_categories (statement_line_id, category_id) VALUES (?, ?)`).run(lineId, cat.id);

    const before = view(accountId, lineId);
    expect(before.expense).toHaveLength(1);
    expect(before.debt).toEqual([{ id: lineId, amount: 456_789 }]);

    const { id: planId } = convertStatementLineToInstallmentPurchase(accountId, lineId, 3);
    const converted = view(accountId, lineId);
    // Counted once, as the plan: the line no longer lists, the plan carries the debt.
    expect(converted.expense.some((l) => l.id === lineId)).toBe(false);
    expect(converted.debt).toEqual([]);
    expect(converted.plans).toBe(1);
    expect(db.prepare(`SELECT 1 FROM cc_statement_lines WHERE id = ?`).get(lineId)).toBeDefined();
    // The plan's lines say whose it is: a converted plan is the user's (editable).
    const planLines = buildFlowsExpenseLines([accountId]).filter((l) => l.installment_purchase_id === planId);
    expect(planLines.length).toBeGreaterThan(0);
    expect(new Set(planLines.map((l) => l.installment_source))).toEqual(new Set(["manual"]));

    updateManualCcInstallmentPurchase(accountId, planId, { cuotas_totales: 6 });
    expect((db.prepare(`SELECT cuotas_totales FROM cc_installment_purchases WHERE id = ?`).get(planId) as { cuotas_totales: number }).cuotas_totales).toBe(6);
    expect(() => updateManualCcInstallmentPurchase(accountId, planId, { total_amount_clp: 1 })).toThrow(/takes its date, amount and merchant/);

    deleteManualCcInstallmentPurchase(accountId, planId);
    expect(view(accountId, lineId)).toEqual(before);
    expect(
      db.prepare(`SELECT category_id FROM cc_expense_line_categories WHERE statement_line_id = ?`).get(lineId)
    ).toEqual({ category_id: cat.id });

    db.prepare(`DELETE FROM cc_statement_lines WHERE statement_id = ?`).run(statementId);
    db.prepare(`DELETE FROM cc_statements WHERE id = ?`).run(statementId);
  });
});
