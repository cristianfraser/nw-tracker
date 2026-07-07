import { describe, expect, it } from "vitest";
import { db } from "./db.js";
import { getCcExpenseCategoryBySlug, stableInstallmentHPurchaseKeyFromLedgerArgs } from "./ccExpenseCategories.js";
import {
  reconcileManualInstallmentPurchasesForStatements,
} from "./ccManualInstallmentStatementReconcile.js";

describe("reconcileManualInstallmentPurchasesForStatements", () => {
  it("deletes manual purchase and transfers category when line matches inside facturación period", () => {
    const master = db
      .prepare(`SELECT id FROM accounts WHERE notes = 'credit_card_master|santander|4242'`)
      .get() as { id: number } | undefined;
    if (!master) return;

    const accountId = master.id;
    const suffix = `reconcile-test-${Date.now()}`;
    const sourcePdf = `${suffix}.pdf`;
    const statementDate = "20/05/2026";
    const periodFrom = "2026-04-21";
    const periodTo = "2026-05-20";
    const purchaseIso = "2026-04-25";
    const merchant = `ZReconcile Test Merchant ${suffix}`;
    const totalClp = 250_000;
    const cuotas = 6;

    const insStmt = db.prepare(
      `INSERT INTO cc_statements (
         account_id, card_group, source_pdf, statement_date, period_from, period_to, pay_by,
         card_last4, card_product, layout, currency,
         saldo_anterior, abono, compras_cargos, deuda_total, monto_facturado
       ) VALUES (?, 'A', ?, ?, ?, ?, '10/06/2026', '4242', NULL, 'compact', 'clp', 0, 0, 0, 0, NULL)`
    );
    const rStmt = insStmt.run(accountId, sourcePdf, statementDate, periodFrom, periodTo);
    const statementId = Number(rStmt.lastInsertRowid);

    const insLine = db.prepare(
      `INSERT INTO cc_statement_lines (
         statement_id, transaction_date, posting_date, place, merchant, description_merged,
         country, amount_orig, orig_currency, amount_clp, amount_usd, installment_flag,
         nro_cuota_current, nro_cuota_total, valor_cuota_mensual_clp, valor_cuota_mensual_usd,
         interest_rate_text, tipo_cuota, dedupe_key, parser_row_id, raw_line
       ) VALUES (?, '25/04/2026', NULL, NULL, ?, NULL, NULL, NULL, NULL, ?, NULL, 1,
         NULL, ?, NULL, NULL, NULL, NULL, ?, ?, 'raw')`
    );
    const dedupeKey = `dedupe-${suffix}`;
    const parserRow = `row-${suffix}`;
    insLine.run(statementId, merchant, totalClp, cuotas, dedupeKey, parserRow);
    const lineRow = db
      .prepare(`SELECT id FROM cc_statement_lines WHERE statement_id = ? AND parser_row_id = ?`)
      .get(statementId, parserRow) as { id: number } | undefined;
    expect(lineRow).toBeDefined();
    const lineId = lineRow!.id;

    const insManual = db.prepare(
      `INSERT INTO cc_installment_purchases (
         account_id, card_group, canonical_row_id, purchase_date, total_amount_clp,
         cuotas_totales, merchant, description_merged, source
       ) VALUES (?, 'A', ?, ?, ?, ?, ?, NULL, 'manual')`
    );
    const canon = `manual-${suffix}`;
    const rMan = insManual.run(accountId, canon, purchaseIso, totalClp, cuotas, merchant);
    const purchaseId = Number(rMan.lastInsertRowid);

    const cat = getCcExpenseCategoryBySlug("supermarket");
    if (!cat) {
      db.prepare(`DELETE FROM cc_statement_lines WHERE statement_id = ?`).run(statementId);
      db.prepare(`DELETE FROM cc_statements WHERE id = ?`).run(statementId);
      return;
    }

    const manualKey = stableInstallmentHPurchaseKeyFromLedgerArgs({
      accountId,
      purchaseDateIso: purchaseIso,
      cuotasTotales: cuotas,
      merchant,
    });
    expect(manualKey).toBeTruthy();
    db.prepare(
      `INSERT INTO cc_expense_unique_purchases (account_id, purchase_key, category_id) VALUES (?, ?, ?)`
    ).run(accountId, manualKey!, cat.id);

    const res = reconcileManualInstallmentPurchasesForStatements(accountId, [statementId]);
    expect(res.matched).toBe(1);
    expect(res.deleted).toBe(1);
    expect(res.categories_transferred).toBe(1);

    const manualStill = db
      .prepare(`SELECT 1 FROM cc_installment_purchases WHERE id = ?`)
      .get(purchaseId) as { 1: number } | undefined;
    expect(manualStill).toBeUndefined();

    const lineCat = db
      .prepare(
        `SELECT c.slug FROM cc_expense_line_categories lc
         JOIN cc_expense_categories c ON c.id = lc.category_id
         WHERE lc.statement_line_id = ?`
      )
      .get(lineId) as { slug: string } | undefined;
    expect(lineCat?.slug).toBe("supermarket");

    db.prepare(`DELETE FROM cc_expense_line_categories WHERE statement_line_id = ?`).run(lineId);
    db.prepare(`DELETE FROM cc_statement_lines WHERE statement_id = ?`).run(statementId);
    db.prepare(`DELETE FROM cc_statements WHERE id = ?`).run(statementId);
    db.prepare(`DELETE FROM cc_expense_unique_purchases WHERE account_id = ? AND purchase_key LIKE ?`).run(
      accountId,
      `%${suffix}%`
    );
  });

  it("does not delete manual purchase when purchase date is outside statement period", () => {
    const master = db
      .prepare(`SELECT id FROM accounts WHERE notes = 'credit_card_master|santander|4242'`)
      .get() as { id: number } | undefined;
    if (!master) return;

    const accountId = master.id;
    const suffix = `reconcile-out-${Date.now()}`;
    const sourcePdf = `${suffix}.pdf`;
    const statementDate = "20/05/2026";
    const periodFrom = "2026-04-21";
    const periodTo = "2026-05-20";
    const merchant = `ZReconcile Out Merchant ${suffix}`;
    const totalClp = 180_000;
    const cuotas = 12;

    const insStmt = db.prepare(
      `INSERT INTO cc_statements (
         account_id, card_group, source_pdf, statement_date, period_from, period_to, pay_by,
         card_last4, card_product, layout, currency,
         saldo_anterior, abono, compras_cargos, deuda_total, monto_facturado
       ) VALUES (?, 'A', ?, ?, ?, ?, '10/06/2026', '4242', NULL, 'compact', 'clp', 0, 0, 0, 0, NULL)`
    );
    const rStmt = insStmt.run(accountId, sourcePdf, statementDate, periodFrom, periodTo);
    const statementId = Number(rStmt.lastInsertRowid);

    db.prepare(
      `INSERT INTO cc_statement_lines (
         statement_id, transaction_date, posting_date, place, merchant, description_merged,
         country, amount_orig, orig_currency, amount_clp, amount_usd, installment_flag,
         nro_cuota_current, nro_cuota_total, valor_cuota_mensual_clp, valor_cuota_mensual_usd,
         interest_rate_text, tipo_cuota, dedupe_key, parser_row_id, raw_line
       ) VALUES (?, '25/04/2026', NULL, NULL, ?, NULL, NULL, NULL, NULL, ?, NULL, 1,
         NULL, ?, NULL, NULL, NULL, NULL, ?, ?, 'raw')`
    ).run(statementId, merchant, totalClp, cuotas, `dedupe-o-${suffix}`, `row-o-${suffix}`);

    const canon = `manual-out-${suffix}`;
    const rMan = db
      .prepare(
        `INSERT INTO cc_installment_purchases (
         account_id, card_group, canonical_row_id, purchase_date, total_amount_clp,
         cuotas_totales, merchant, description_merged, source
       ) VALUES (?, 'A', ?, '2026-03-10', ?, ?, ?, NULL, 'manual')`
      )
      .run(accountId, canon, totalClp, cuotas, merchant);
    const purchaseId = Number(rMan.lastInsertRowid);

    const res = reconcileManualInstallmentPurchasesForStatements(accountId, [statementId]);
    expect(res.matched).toBe(0);
    expect(res.deleted).toBe(0);

    const manualStill = db
      .prepare(`SELECT 1 FROM cc_installment_purchases WHERE id = ?`)
      .get(purchaseId) as { 1: number } | undefined;
    expect(manualStill).toBeDefined();

    db.prepare(`DELETE FROM cc_statement_lines WHERE statement_id = ?`).run(statementId);
    db.prepare(`DELETE FROM cc_statements WHERE id = ?`).run(statementId);
    db.prepare(`DELETE FROM cc_installment_purchases WHERE id = ?`).run(purchaseId);
  });
});
