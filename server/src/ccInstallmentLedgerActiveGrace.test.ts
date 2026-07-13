import { afterEach, describe, expect, it } from "vitest";
import { db } from "./db.js";
import {
  ccInstallmentsDbApiPayload,
  installmentPurchaseShowsActive,
  lastInstallmentPaymentPayByYmd,
} from "./ccInstallmentLedgerDb.js";

describe("installmentPurchaseShowsActive", () => {
  it("keeps fully paid purchase active until its final cuota pay-by date, then completes it", () => {
    const payList = [
      {
        id: 1,
        purchase_id: 1,
        pay_by_date: "2026-06-25",
        statement_date: "25/05/2026",
        statement_period_month: "2026-05",
        period_to_join: null,
        source_pdf: "may.pdf",
        amount_clp: 10_000,
        cuota_current: 3,
        cuota_total: null,
      },
    ];
    expect(lastInstallmentPaymentPayByYmd(payList)).toBe("2026-06-25");
    const settled = {
      remaining_installments: 0,
      remaining_principal_clp: 0,
      installments_paid: 3,
      installment_count: 3,
    };
    // Day before pay-by → still active.
    expect(installmentPurchaseShowsActive(settled, payList, "2026-06-24")).toBe(true);
    // On the pay-by date → completed.
    expect(installmentPurchaseShowsActive(settled, payList, "2026-06-25")).toBe(false);
    // After the pay-by date → completed.
    expect(installmentPurchaseShowsActive(settled, payList, "2026-07-13")).toBe(false);
  });

  it("still treats outstanding installments as active regardless of date", () => {
    expect(
      installmentPurchaseShowsActive(
        {
          remaining_installments: 2,
          remaining_principal_clp: 20_000,
          installments_paid: 1,
          installment_count: 3,
        },
        [],
        "2030-01-01"
      )
    ).toBe(true);
  });
});

describe("ccInstallmentsDbApiPayload active-through-pay-by", () => {
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

  function insertFinalCuotaPurchase(canonicalId: string, finalPayByYmd: string): number {
    const master = db
      .prepare(`SELECT id FROM accounts WHERE notes = 'credit_card_master|santander|vitest-fixture' LIMIT 1`)
      .get() as { id: number } | undefined;
    if (!master) throw new Error("vitest CC master fixture missing");

    db.prepare(
      `INSERT INTO cc_statements (account_id, card_group, source_pdf, statement_date, period_from, period_to)
       VALUES (?, 'A', ?, ?, ?, ?)`
    ).run(master.id, `vitest-${canonicalId}.pdf`, "25/05/2026", "24/04/2026", "25/05/2026");
    insertedStatementIds.push((db.prepare(`SELECT last_insert_rowid() AS id`).get() as { id: number }).id);

    db.prepare(
      `INSERT INTO cc_installment_purchases (
         account_id, card_group, canonical_row_id, dedupe_key, parser_row_id_sample, source_pdf_sample,
         purchase_date, total_amount_clp, cuotas_totales, merchant, description_merged, matched_baseline_purchase_id, source
       ) VALUES (?, 'A', ?, NULL, NULL, NULL, ?, ?, ?, ?, ?, NULL, 'pdf')`
    ).run(master.id, canonicalId, "2026-03-01", 30_000, 3, "VITEST FINAL", "VITEST FINAL");
    const pid = (
      db.prepare(
        `SELECT id FROM cc_installment_purchases WHERE account_id = ? AND canonical_row_id = ?`
      ).get(master.id, canonicalId) as { id: number }
    ).id;
    insertedPurchaseIds.push(pid);

    const insPay = db.prepare(
      `INSERT INTO cc_installment_payments (
         purchase_id, pay_by_date, statement_date, statement_period_month, source_pdf, amount_clp, cuota_current, cuota_total, parser_row_id
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)`
    );
    insPay.run(pid, "2026-04-25", "24/04/2026", "2026-04", "apr.pdf", 10_000, 1, 3);
    insPay.run(pid, "2026-05-25", "24/05/2026", "2026-05", "may.pdf", 10_000, 2, 3);
    insPay.run(pid, finalPayByYmd, "24/05/2026", "2026-05", "may.pdf", 10_000, 3, 3);
    return master.id;
  }

  it("lists a final-cuota purchase under active while its pay-by date is in the future", () => {
    const master = insertFinalCuotaPurchase("final-cuota-future", "2999-06-25");
    const payload = ccInstallmentsDbApiPayload(master);
    expect(payload.purchases.some((p) => p.purchase_id === "final-cuota-future")).toBe(true);
    expect(payload.purchases_completed.some((p) => p.purchase_id === "final-cuota-future")).toBe(false);
    const activeRow = payload.purchases.find((p) => p.purchase_id === "final-cuota-future");
    expect(activeRow?.payment_statements?.length).toBe(3);
    expect(activeRow?.payment_statements?.every((st) => (st.cuota_current ?? 0) > 0)).toBe(true);
  });

  it("moves a final-cuota purchase to completed once its pay-by date has passed", () => {
    const master = insertFinalCuotaPurchase("final-cuota-past", "2020-06-25");
    const payload = ccInstallmentsDbApiPayload(master);
    expect(payload.purchases.some((p) => p.purchase_id === "final-cuota-past")).toBe(false);
    expect(payload.purchases_completed.some((p) => p.purchase_id === "final-cuota-past")).toBe(true);
  });
});
