import { afterEach, describe, expect, it } from "vitest";
import { db } from "./db.js";
import {
  ccInstallmentsDbApiPayload,
  installmentPurchaseShowsActive,
  lastInstallmentPaymentStatementMonthYm,
  latestUploadedStatementMonthYm,
} from "./ccInstallmentLedgerDb.js";

describe("installmentPurchaseShowsActive", () => {
  it("keeps fully paid purchase active when final cuota is on latest uploaded statement", () => {
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
      },
    ];
    expect(lastInstallmentPaymentStatementMonthYm(payList)).toBe("2026-05");
    expect(
      installmentPurchaseShowsActive(
        {
          remaining_installments: 0,
          remaining_principal_clp: 0,
          installments_paid: 3,
          installment_count: 3,
        },
        payList,
        "2026-05"
      )
    ).toBe(true);
    expect(
      installmentPurchaseShowsActive(
        {
          remaining_installments: 0,
          remaining_principal_clp: 0,
          installments_paid: 3,
          installment_count: 3,
        },
        payList,
        "2026-06"
      )
    ).toBe(false);
  });

  it("still treats outstanding installments as active regardless of statement month", () => {
    expect(
      installmentPurchaseShowsActive(
        {
          remaining_installments: 2,
          remaining_principal_clp: 20_000,
          installments_paid: 1,
          installment_count: 3,
        },
        [],
        "2026-05"
      )
    ).toBe(true);
  });
});

describe("ccInstallmentsDbApiPayload active grace", () => {
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

  it("lists final-cuota purchase under active until a newer statement exists", () => {
    const master = db
      .prepare(`SELECT id FROM accounts WHERE notes = 'credit_card_master|santander|vitest-fixture' LIMIT 1`)
      .get() as { id: number } | undefined;
    if (!master) return;

    db.prepare(
      `INSERT INTO cc_statements (account_id, card_group, source_pdf, statement_date, period_from, period_to)
       VALUES (?, 'A', ?, ?, ?, ?)`
    ).run(master.id, "vitest-may.pdf", "25/05/2026", "24/04/2026", "25/05/2026");
    insertedStatementIds.push((db.prepare(`SELECT last_insert_rowid() AS id`).get() as { id: number }).id);

    db.prepare(
      `INSERT INTO cc_installment_purchases (
         account_id, card_group, canonical_row_id, dedupe_key, parser_row_id_sample, source_pdf_sample,
         purchase_date, total_amount_clp, cuotas_totales, merchant, description_merged, matched_baseline_purchase_id, source
       ) VALUES (?, 'A', ?, NULL, NULL, NULL, ?, ?, ?, ?, ?, NULL, 'pdf')`
    ).run(master.id, "final-cuota-grace", "2026-03-01", 30_000, 3, "VITEST FINAL", "VITEST FINAL");
    const pid = (
      db.prepare(
        `SELECT id FROM cc_installment_purchases WHERE account_id = ? AND canonical_row_id = 'final-cuota-grace'`
      ).get(master.id) as { id: number }
    ).id;
    insertedPurchaseIds.push(pid);

    const insPay = db.prepare(
      `INSERT INTO cc_installment_payments (
         purchase_id, pay_by_date, statement_date, statement_period_month, source_pdf, amount_clp, cuota_current, cuota_total, parser_row_id
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)`
    );
    insPay.run(pid, "2026-04-25", "24/04/2026", "2026-04", "apr.pdf", 10_000, 1, 3);
    insPay.run(pid, "2026-05-25", "24/05/2026", "2026-05", "may.pdf", 10_000, 2, 3);
    insPay.run(pid, "2026-06-25", "24/05/2026", "2026-05", "may.pdf", 10_000, 3, 3);

    const payloadMay = ccInstallmentsDbApiPayload(master.id);
    expect(payloadMay.purchases.some((p) => p.purchase_id === "final-cuota-grace")).toBe(true);
    expect(payloadMay.purchases_completed.some((p) => p.purchase_id === "final-cuota-grace")).toBe(false);
    const graceRow = payloadMay.purchases.find((p) => p.purchase_id === "final-cuota-grace");
    expect(graceRow?.payment_statements?.length).toBe(3);
    expect(graceRow?.payment_statements?.every((st) => (st.cuota_current ?? 0) > 0)).toBe(true);

    db.prepare(
      `INSERT INTO cc_statements (account_id, card_group, source_pdf, statement_date, period_from, period_to)
       VALUES (?, 'A', ?, ?, ?, ?)`
    ).run(master.id, "vitest-jun.pdf", "25/06/2026", "24/05/2026", "25/06/2026");
    insertedStatementIds.push((db.prepare(`SELECT last_insert_rowid() AS id`).get() as { id: number }).id);

    const payloadJun = ccInstallmentsDbApiPayload(master.id);
    expect(payloadJun.purchases.some((p) => p.purchase_id === "final-cuota-grace")).toBe(false);
    expect(payloadJun.purchases_completed.some((p) => p.purchase_id === "final-cuota-grace")).toBe(true);
  });

  it("ignores import:web-paste open bucket when resolving latest imported cartola month", () => {
    const master = db
      .prepare(`SELECT id FROM accounts WHERE notes = 'credit_card_master|santander|vitest-fixture' LIMIT 1`)
      .get() as { id: number } | undefined;
    if (!master) return;

    db.prepare(
      `INSERT INTO cc_statements (account_id, card_group, source_pdf, statement_date, period_from, period_to)
       VALUES (?, 'A', ?, ?, ?, ?)`
    ).run(master.id, "2026-05-25 vitest cartola.pdf", "25/05/2026", "24/04/2026", "25/05/2026");
    insertedStatementIds.push((db.prepare(`SELECT last_insert_rowid() AS id`).get() as { id: number }).id);
    db.prepare(
      `INSERT INTO cc_statements (account_id, card_group, source_pdf, statement_date, period_from, period_to)
       VALUES (?, 'A', ?, ?, ?, ?)`
    ).run(
      master.id,
      "import:web-paste|open|2026-06",
      "open",
      "2026-06",
      "20/06/2026"
    );
    insertedStatementIds.push((db.prepare(`SELECT last_insert_rowid() AS id`).get() as { id: number }).id);

    expect(latestUploadedStatementMonthYm(master.id)).toBe("2026-05");
  });
});
