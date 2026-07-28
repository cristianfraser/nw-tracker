import { afterEach, describe, expect, it } from "vitest";
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

/**
 * The web-paste↔PDF twin scenario from 2026-07 (·7817): a plan converted from a pasted
 * line carries the issuer-derived card_group ('santander') and a purchase date one day
 * off the statement line's date. The reconcile must still collapse it onto the PDF line
 * (web-paste group compatibility + ±2d tolerance), and dry-run must report only.
 */
describe("reconcileManualInstallmentPurchasesForStatements — web-paste twins", () => {
  const accountIds: number[] = [];

  afterEach(() => {
    for (const id of accountIds) {
      db.prepare(`DELETE FROM cc_installment_purchases WHERE account_id = ?`).run(id);
      db.prepare(`DELETE FROM cc_statements WHERE account_id = ?`).run(id);
      db.prepare(`DELETE FROM accounts WHERE id = ?`).run(id);
    }
    accountIds.length = 0;
  });

  function makeFixture(): { accountId: number; statementId: number; manualId: number } {
    const group = db.prepare(`SELECT id FROM asset_groups LIMIT 1`).get() as { id: number };
    const accountId = Number(
      db
        .prepare(`INSERT INTO accounts (asset_group_id, name, notes, import_key) VALUES (?, ?, ?, ?)`)
        .run(
          group.id,
          "Vitest · web-paste twin reconcile",
          "credit_card_master|santander|4747",
          "vitest-webpaste-twin-reconcile"
        ).lastInsertRowid
    );
    accountIds.push(accountId);

    const statementId = Number(
      db
        .prepare(
          `INSERT INTO cc_statements (account_id, card_group, source_pdf, statement_date, period_from, period_to, layout, currency)
           VALUES (?, 'A', 'vitest twin jul.pdf', '23/07/2026', '23/06/2026', '23/07/2026', 'compact', 'clp')`
        )
        .run(accountId).lastInsertRowid
    );
    db.prepare(
      `INSERT INTO cc_statement_lines (
         statement_id, transaction_date, merchant, amount_clp, installment_flag,
         nro_cuota_current, nro_cuota_total, valor_cuota_mensual_clp, dedupe_key, parser_row_id, raw_line
       ) VALUES (?, '25/06/26', 'MP     *MERCADO LIBRE', 544574, 1, 1, 12, 45381, 'vitest-twin-line', 'vitest-twin-line', 'raw')`
    ).run(statementId);

    // The surviving PDF twin plan (created by the statement import in production) — the
    // purchase-key migration derives its modern key from this row.
    db.prepare(
      `INSERT INTO cc_installment_purchases (
         account_id, card_group, canonical_row_id, purchase_date, total_amount_clp,
         cuotas_totales, merchant, source
       ) VALUES (?, 'A', 'vitest-pdf-twin', '2026-06-25', 544574, 12, 'MP     *MERCADO LIBRE', 'pdf')`
    ).run(accountId);

    const manualId = Number(
      db
        .prepare(
          `INSERT INTO cc_installment_purchases (
             account_id, card_group, canonical_row_id, purchase_date, total_amount_clp,
             cuotas_totales, merchant, source
           ) VALUES (?, 'santander', 'vitest-manual-twin', '2026-06-26', 544574, 12, 'MP *MERCADO', 'manual')`
        )
        .run(accountId).lastInsertRowid
    );
    return { accountId, statementId, manualId };
  }

  it("dry-run reports the web-paste-group twin (±1d date skew) without deleting", () => {
    const { accountId, statementId, manualId } = makeFixture();
    const report = reconcileManualInstallmentPurchasesForStatements(accountId, [statementId], {
      dryRun: true,
    });
    expect(report.matched).toBe(1);
    expect(report.deleted).toBe(0);
    expect(report.matches[0]!.manual_id).toBe(manualId);
    expect(db.prepare(`SELECT id FROM cc_installment_purchases WHERE id = ?`).get(manualId)).toBeTruthy();
  });

  it("apply deletes the twin", () => {
    const { accountId, statementId, manualId } = makeFixture();
    const result = reconcileManualInstallmentPurchasesForStatements(accountId, [statementId]);
    expect(result.matched).toBe(1);
    expect(result.deleted).toBe(1);
    expect(db.prepare(`SELECT id FROM cc_installment_purchases WHERE id = ?`).get(manualId)).toBeFalsy();
  });

  it("repoints financing-link and note purchase_key refs at the surviving PDF key", () => {
    const { accountId, statementId } = makeFixture();
    // Keys embed the manual's merchant («MP *MERCADO») — as stored by the financing-link UI.
    const manualKey = `installment-h:${accountId}:2026-06-26:12:544574:MP *MERCADO`;
    const linkId = Number(
      db
        .prepare(
          `INSERT INTO cc_facturado_financing_links (financed_account_id, financed_billing_month) VALUES (?, '2026-06')`
        )
        .run(accountId).lastInsertRowid
    );
    db.prepare(
      `INSERT INTO cc_facturado_financing_link_purchases (link_id, financing_account_id, financing_purchase_key)
       VALUES (?, ?, ?)`
    ).run(linkId, accountId, manualKey);
    db.prepare(
      `INSERT INTO cc_expense_purchase_notes (account_id, purchase_key, notes) VALUES (?, ?, 'vitest twin note')`
    ).run(accountId, manualKey);

    try {
      const result = reconcileManualInstallmentPurchasesForStatements(accountId, [statementId]);
      expect(result.deleted).toBe(1);
      expect(result.purchase_key_refs_rewritten).toBe(2);

      const pdfKey = `installment-h:${accountId}:2026-06-25:12:544574:MP *MERCADO LIBRE`;
      const linkRow = db
        .prepare(`SELECT financing_purchase_key FROM cc_facturado_financing_link_purchases WHERE link_id = ?`)
        .get(linkId) as { financing_purchase_key: string };
      expect(linkRow.financing_purchase_key).toBe(pdfKey);
      const noteRow = db
        .prepare(`SELECT notes FROM cc_expense_purchase_notes WHERE account_id = ? AND purchase_key = ?`)
        .get(accountId, pdfKey) as { notes: string } | undefined;
      expect(noteRow?.notes).toBe("vitest twin note");
    } finally {
      db.prepare(`DELETE FROM cc_facturado_financing_link_purchases WHERE link_id = ?`).run(linkId);
      db.prepare(`DELETE FROM cc_facturado_financing_links WHERE id = ?`).run(linkId);
      db.prepare(`DELETE FROM cc_expense_purchase_notes WHERE account_id = ?`).run(accountId);
    }
  });

  it("converts (not deletes) a manual plan when no separate pdf plan represents the contract", () => {
    // The TGR scenario: the ledger merge fingerprint-matched the statement contract INTO the
    // manual row, so the fixture's pdf twin does not exist — deleting would erase the contract.
    const { accountId, statementId, manualId } = makeFixture();
    db.prepare(
      `DELETE FROM cc_installment_purchases WHERE account_id = ? AND canonical_row_id = 'vitest-pdf-twin'`
    ).run(accountId);

    const dry = reconcileManualInstallmentPurchasesForStatements(accountId, [statementId], {
      dryRun: true,
    });
    expect(dry.matches[0]!.action).toBe("converted");
    expect(
      (db.prepare(`SELECT source FROM cc_installment_purchases WHERE id = ?`).get(manualId) as {
        source: string;
      }).source
    ).toBe("manual");

    const result = reconcileManualInstallmentPurchasesForStatements(accountId, [statementId]);
    expect(result.matched).toBe(1);
    expect(result.converted).toBe(1);
    expect(result.deleted).toBe(0);
    const row = db
      .prepare(`SELECT source, source_pdf_sample FROM cc_installment_purchases WHERE id = ?`)
      .get(manualId) as { source: string; source_pdf_sample: string | null };
    expect(row.source).toBe("pdf");
    expect(row.source_pdf_sample).toBe("vitest twin jul.pdf");
  });

  it("does not match across a 4-day date gap on an indexed cuota line", () => {
    const { accountId, statementId, manualId } = makeFixture();
    db.prepare(`UPDATE cc_installment_purchases SET purchase_date = '2026-06-29' WHERE id = ?`).run(
      manualId
    );
    const report = reconcileManualInstallmentPurchasesForStatements(accountId, [statementId], {
      dryRun: true,
    });
    expect(report.matched).toBe(0);
  });
});
