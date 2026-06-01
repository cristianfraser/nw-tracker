import { afterEach, describe, expect, it } from "vitest";
import { db } from "./db.js";
import {
  assertNoDuplicateInstallmentPurchaseFingerprints,
  ccInstallmentsDbApiPayload,
  ledgerInstallmentsPaid,
} from "./ccInstallmentLedgerDb.js";

function stmtMonthFromPayBy(payBy: string): string {
  return payBy.slice(0, 7);
}

describe("ledgerInstallmentsPaid", () => {
  it("marks contract fully paid when final payment row is unindexed", () => {
    const purchase = {
      id: 1,
      canonical_row_id: "mk-webpay-test",
      card_group: "A",
      purchase_date: "2025-02-10",
      total_amount_clp: 1_200_000,
      cuotas_totales: 12,
      merchant: "MK WEBPAY.CL",
      description_merged: "MK WEBPAY.CL",
      matched_baseline_purchase_id: null,
      source: "pdf",
    };

    const payList = Array.from({ length: 11 }, (_, idx) => ({
      id: idx + 1,
      purchase_id: 1,
      pay_by_date: `2025-${String(idx + 2).padStart(2, "0")}-25`,
      statement_date: null,
      statement_period_month: stmtMonthFromPayBy(`2025-${String(idx + 2).padStart(2, "0")}-25`),
      period_to_join: null,
      source_pdf: null,
      amount_clp: 100_000,
      cuota_current: idx + 1,
    }));
    payList.push({
      id: 12,
      purchase_id: 1,
      pay_by_date: "2026-01-25",
      statement_date: null,
      statement_period_month: "2026-01",
      period_to_join: null,
      source_pdf: null,
      amount_clp: 100_000,
      cuota_current: null,
    });

    expect(ledgerInstallmentsPaid(purchase, payList, "2026-02")).toBe(12);
  });
});

describe("ccInstallmentsDbApiPayload", () => {
  const insertedStatementIds: number[] = [];
  const insertedPurchaseIds: number[] = [];

  afterEach(() => {
    if (insertedStatementIds.length > 0) {
      const phs = insertedStatementIds.map(() => "?").join(",");
      db.prepare(`DELETE FROM cc_statement_lines WHERE statement_id IN (${phs})`).run(...insertedStatementIds);
      db.prepare(`DELETE FROM cc_statements WHERE id IN (${phs})`).run(...insertedStatementIds);
      insertedStatementIds.length = 0;
    }
    if (insertedPurchaseIds.length === 0) return;
    const ph = insertedPurchaseIds.map(() => "?").join(",");
    db.prepare(`DELETE FROM cc_installment_payments WHERE purchase_id IN (${ph})`).run(...insertedPurchaseIds);
    db.prepare(`DELETE FROM cc_installment_purchases WHERE id IN (${ph})`).run(...insertedPurchaseIds);
    insertedPurchaseIds.length = 0;
  });

  it("throws when duplicate purchase fingerprints exist for the account", () => {
    const master = db
      .prepare(`SELECT id FROM accounts WHERE notes = 'credit_card_master|santander|vitest-fixture' LIMIT 1`)
      .get() as { id: number } | undefined;
    if (!master) return;

    const insPurchase = db.prepare(
      `INSERT INTO cc_installment_purchases (
         account_id, card_group, canonical_row_id, dedupe_key, parser_row_id_sample, source_pdf_sample,
         purchase_date, total_amount_clp, cuotas_totales, merchant, description_merged, matched_baseline_purchase_id, source
       ) VALUES (?, 'A', ?, NULL, NULL, NULL, ?, ?, ?, ?, ?, NULL, 'pdf')`
    );
    insPurchase.run(master.id, "dup-1", "2025-02-26", 120_000, 3, "VITEST DUP", "VITEST DUP");
    insPurchase.run(master.id, "dup-2", "2025-02-26", 120_000, 3, "VITEST DUP", "VITEST DUP");
    const rows = db
      .prepare(
        `SELECT id, canonical_row_id, purchase_date, total_amount_clp, cuotas_totales, merchant
         FROM cc_installment_purchases
         WHERE account_id = ? AND canonical_row_id IN ('dup-1','dup-2') ORDER BY id`
      )
      .all(master.id) as {
      id: number;
      canonical_row_id: string;
      purchase_date: string;
      total_amount_clp: number;
      cuotas_totales: number;
      merchant: string | null;
    }[];
    insertedPurchaseIds.push(...rows.map((r) => r.id));

    expect(() => assertNoDuplicateInstallmentPurchaseFingerprints(master.id, rows)).toThrow(
      /duplicate installment purchase fingerprint/
    );
    expect(() => ccInstallmentsDbApiPayload(master.id)).toThrow(/duplicate installment purchase fingerprint/);
  });

  it("hides cancelled installment purchases from cuotas tables", () => {
    const master = db
      .prepare(`SELECT id FROM accounts WHERE notes = 'credit_card_master|santander|vitest-fixture' LIMIT 1`)
      .get() as { id: number } | undefined;
    if (!master) return;

    db.prepare(
      `INSERT INTO cc_installment_purchases (
         account_id, card_group, canonical_row_id, dedupe_key, parser_row_id_sample, source_pdf_sample,
         purchase_date, total_amount_clp, cuotas_totales, merchant, description_merged, matched_baseline_purchase_id, source
       ) VALUES (?, 'A', ?, NULL, NULL, NULL, ?, ?, ?, ?, ?, NULL, 'pdf')`
    ).run(master.id, "cancelled-1", "2025-02-07", 54_990, 6, "MP MERCADO LIBRE", "MP MERCADO LIBRE");
    const pid = (
      db.prepare(
        `SELECT id FROM cc_installment_purchases WHERE account_id = ? AND canonical_row_id = 'cancelled-1'`
      ).get(master.id) as { id: number }
    ).id;
    insertedPurchaseIds.push(pid);

    db.prepare(
      `INSERT INTO cc_statements (account_id, card_group, source_pdf, statement_date, period_from, period_to)
       VALUES (?, 'A', ?, ?, ?, ?)`
    ).run(master.id, "cancelled-note.pdf", "25/03/2025", "24/02/2025", "25/03/2025");
    const sid = (db.prepare(`SELECT last_insert_rowid() AS id`).get() as { id: number }).id;
    insertedStatementIds.push(sid);
    db.prepare(
      `INSERT INTO cc_statement_lines (statement_id, merchant, description_merged, amount_clp, installment_flag)
       VALUES (?, 'NOTA DE CREDITO', 'SANTIAGO | NOTA DE CREDITO', ?, 0)`
    ).run(sid, -54_990);

    const payload = ccInstallmentsDbApiPayload(master.id);
    const inTables = [...payload.purchases, ...payload.purchases_completed].find(
      (p) => p.purchase_id === "cancelled-1"
    );
    expect(inTables).toBeUndefined();
    const hidden = payload.hidden_cancelled_purchases.find((p) => p.purchase_id === "cancelled-1");
    expect(hidden).toBeDefined();
  });
});
