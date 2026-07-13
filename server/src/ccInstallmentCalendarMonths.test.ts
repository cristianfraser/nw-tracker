import { afterEach, describe, expect, it } from "vitest";
import { db } from "./db.js";
import { ccInstallmentsDbApiPayload } from "./ccInstallmentLedgerDb.js";

/**
 * Cuotas-por-facturación calendar: rows are facturación months carrying their pay-by date
 * and the plan debt left after that payment (suffix sum); rows roll off past their pay-by.
 */
describe("ccInstallmentsDbApiPayload facturación calendar", () => {
  const insertedPurchaseIds: number[] = [];

  afterEach(() => {
    if (insertedPurchaseIds.length === 0) return;
    const ph = insertedPurchaseIds.map(() => "?").join(",");
    db.prepare(`DELETE FROM cc_installment_payments WHERE purchase_id IN (${ph})`).run(...insertedPurchaseIds);
    db.prepare(`DELETE FROM cc_installment_purchases WHERE id IN (${ph})`).run(...insertedPurchaseIds);
    insertedPurchaseIds.length = 0;
  });

  function fixtureMasterId(): number | null {
    const master = db
      .prepare(`SELECT id FROM accounts WHERE notes = 'credit_card_master|santander|vitest-fixture' LIMIT 1`)
      .get() as { id: number } | undefined;
    return master?.id ?? null;
  }

  function insertPlan(
    accountId: number,
    canonicalId: string,
    opts: { purchaseDate: string; cuotaRows: { payBy: string; stmtDate: string; stmtYm: string; cuota: number }[] }
  ): number {
    db.prepare(
      `INSERT INTO cc_installment_purchases (
         account_id, card_group, canonical_row_id, dedupe_key, parser_row_id_sample, source_pdf_sample,
         purchase_date, total_amount_clp, cuotas_totales, merchant, description_merged, matched_baseline_purchase_id, source
       ) VALUES (?, 'A', ?, NULL, NULL, NULL, ?, 30000, 3, 'VITEST CAL', 'VITEST CAL', NULL, 'pdf')`
    ).run(accountId, canonicalId, opts.purchaseDate);
    const pid = (
      db.prepare(
        `SELECT id FROM cc_installment_purchases WHERE account_id = ? AND canonical_row_id = ?`
      ).get(accountId, canonicalId) as { id: number }
    ).id;
    insertedPurchaseIds.push(pid);
    const ins = db.prepare(
      `INSERT INTO cc_installment_payments (
         purchase_id, pay_by_date, statement_date, statement_period_month, source_pdf, amount_clp, cuota_current, cuota_total, parser_row_id
       ) VALUES (?, ?, ?, ?, 'vitest-cal.pdf', 10000, ?, 3, NULL)`
    );
    for (const r of opts.cuotaRows) ins.run(pid, r.payBy, r.stmtDate, r.stmtYm, r.cuota);
    return pid;
  }

  it("emits facturación rows with evidence pay-by, derived pay-by, and suffix-sum debt", () => {
    const master = fixtureMasterId();
    if (!master) return;
    insertPlan(master, "cal-suffix", {
      purchaseDate: "2098-12-15",
      cuotaRows: [
        { payBy: "2099-02-09", stmtDate: "22/01/2099", stmtYm: "2099-01", cuota: 1 },
        { payBy: "2099-03-09", stmtDate: "22/02/2099", stmtYm: "2099-02", cuota: 2 },
      ],
    });

    const payload = ccInstallmentsDbApiPayload(master);
    const rows = payload.months.filter((m) => m.month.startsWith("2099-"));
    expect(rows.map((m) => m.month)).toEqual(["2099-01", "2099-02", "2099-03"]);

    // Closed facturaciones carry the statement's PAGAR HASTA; the unbilled one derives ~10th next month.
    expect(rows[0]!.pay_by_date).toBe("2099-02-09");
    expect(rows[1]!.pay_by_date).toBe("2099-03-09");
    expect(rows[2]!.pay_by_date).toBe("2099-04-10");

    // Suffix sums: each row's debt = what is left after paying that facturación; last row 0.
    expect(rows.map((m) => m.total_clp)).toEqual([10000, 10000, 10000]);
    expect(rows[0]!.debt_after_clp).toBe(20000);
    expect(rows[1]!.debt_after_clp).toBe(10000);
    expect(rows[2]!.debt_after_clp).toBe(0);
    for (let i = 0; i + 1 < rows.length; i++) {
      expect(rows[i]!.debt_after_clp).toBe(rows[i + 1]!.total_clp + rows[i + 1]!.debt_after_clp);
    }

    // Próximo pago reports the PAY month of the first visible row, not the facturación month.
    expect(payload.totals.next_calendar_month).toBe("2099-02");
    expect(payload.totals.next_calendar_month_total_clp).toBe(10000);
  });

  it("rolls a facturación row off the calendar once its pay-by date has passed", () => {
    const master = fixtureMasterId();
    if (!master) return;
    insertPlan(master, "cal-rolloff", {
      purchaseDate: "2019-12-15",
      cuotaRows: [
        { payBy: "2020-02-09", stmtDate: "22/01/2020", stmtYm: "2020-01", cuota: 1 },
        { payBy: "2020-03-09", stmtDate: "22/02/2020", stmtYm: "2020-02", cuota: 2 },
        { payBy: "2020-04-09", stmtDate: "22/03/2020", stmtYm: "2020-03", cuota: 3 },
      ],
    });

    const payload = ccInstallmentsDbApiPayload(master);
    expect(payload.months.filter((m) => m.month.startsWith("2020-"))).toHaveLength(0);
  });
});
