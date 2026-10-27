import { afterEach, describe, expect, it, vi } from "vitest";
import { db } from "./db.js";
import { ccInstallmentsDbApiPayload } from "./ccInstallmentLedgerDb.js";
import { buildBillingDetailByMonth } from "./ccBillingViews.js";
import type { CcInstallmentMonthRow } from "./creditCardInstallments.js";

/**
 * Projected billing months are pay-frame: month-end owed = plan remainder after the PREVIOUS
 * month's close (billing at ~20th is a reclassification; the money leaves on the ~10th of the
 * next month). The series steps down one facturación per month and lands on a trailing zero.
 */
describe("appendProjectedBillingDetailRows pay-frame", () => {
  const insertedStatementIds: number[] = [];
  const insertedPurchaseIds: number[] = [];

  afterEach(() => {
    vi.useRealTimers();
    if (insertedStatementIds.length > 0) {
      const phs = insertedStatementIds.map(() => "?").join(",");
      db.prepare(`DELETE FROM cc_statements WHERE id IN (${phs})`).run(...insertedStatementIds);
      insertedStatementIds.length = 0;
    }
    if (insertedPurchaseIds.length === 0) return;
    const ph = insertedPurchaseIds.map(() => "?").join(",");
    db.prepare(`DELETE FROM cc_installment_payments WHERE purchase_id IN (${ph})`).run(...insertedPurchaseIds);
    db.prepare(`DELETE FROM cc_installment_purchases WHERE id IN (${ph})`).run(...insertedPurchaseIds);
    insertedPurchaseIds.length = 0;
  });

  it("projects owed-at-month-end (previous close) and lands on a trailing zero month", () => {
    const master = db
      .prepare(`SELECT id FROM accounts WHERE notes = 'credit_card_master|santander|vitest-fixture' LIMIT 1`)
      .get() as { id: number } | undefined;
    if (!master) return;
    // The fixture lives in 2030: read it from inside the open cycle, so the live cupo counts the
    // January statement's cuota as billed (a 2026 clock reads every cuota of a 2030 plan as unbilled).
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2030-01-25T15:00:00Z"));

    // One closed statement (2030-01) so `existing` has a row to project beyond.
    db.prepare(
      `INSERT INTO cc_statements (account_id, card_group, source_pdf, statement_date, period_from, period_to)
       VALUES (?, 'A', 'vitest-payframe.pdf', '20/01/2030', '21/12/2029', '20/01/2030')`
    ).run(master.id);
    insertedStatementIds.push((db.prepare(`SELECT last_insert_rowid() AS id`).get() as { id: number }).id);

    // 3-cuota plan: cuota 1 billed on the 2030-01 statement; cuotas 2–3 unbilled.
    db.prepare(
      `INSERT INTO cc_installment_purchases (
         account_id, card_group, canonical_row_id, dedupe_key, parser_row_id_sample, source_pdf_sample,
         purchase_date, total_amount_clp, cuotas_totales, merchant, description_merged, matched_baseline_purchase_id, source
       ) VALUES (?, 'A', 'payframe-plan', NULL, NULL, NULL, '2030-01-05', 30000, 3, 'VITEST PAYFRAME', 'VITEST PAYFRAME', NULL, 'pdf')`
    ).run(master.id);
    const pid = (
      db.prepare(
        `SELECT id FROM cc_installment_purchases WHERE account_id = ? AND canonical_row_id = 'payframe-plan'`
      ).get(master.id) as { id: number }
    ).id;
    insertedPurchaseIds.push(pid);
    db.prepare(
      `INSERT INTO cc_installment_payments (
         purchase_id, pay_by_date, statement_date, statement_period_month, source_pdf, amount_clp, cuota_current, cuota_total, parser_row_id
       ) VALUES (?, '2030-02-10', '20/01/2030', '2030-01', 'vitest-payframe.pdf', 10000, 1, 3, NULL)`
    ).run(pid);

    const payload = ccInstallmentsDbApiPayload(master.id);
    const allScheduleMonths: CcInstallmentMonthRow[] = payload.installment_history_months.map((h) => ({
      month: h.month,
      total_clp: h.installment_payments_clp,
      breakdown: [],
    }));
    const detail = buildBillingDetailByMonth(master.id, allScheduleMonths);
    const byMonth = new Map(detail.map((r) => [r.billing_month, r] as const));

    // Closed month keeps the bank frame: cupo after its own close (cuota 1 billed → 20k left).
    expect(byMonth.get("2030-01")?.cupo_statement_clp).toBe(20_000);

    // 2030-02 is the OPEN facturación (the month after the last close), a row of its own even
    // before a line or a snapshot row lands in it, in the live frame: the live cupo (cuotas 2–3,
    // the January statement billed cuota 1) and January's balance rolled forward — cuota 1 is
    // billed but unpaid until 10-feb, so 30.000 is still owed today.
    const feb = byMonth.get("2030-02");
    expect(feb?.projected).toBeUndefined();
    expect(feb?.as_of_kind).toBe("manual");
    expect(feb?.cupo_statement_clp).toBe(20_000);
    expect(feb?.balance_statement_clp).toBe(30_000);

    // Projected months are pay-frame: owed at month-end = remainder after the PREVIOUS close.
    // 2030-03: cuota 2 (billed feb) pays 10-mar → 1x.xxx owed.
    expect(byMonth.get("2030-03")?.projected).toBe(true);
    expect(byMonth.get("2030-03")?.cupo_statement_clp).toBe(10_000);
    expect(byMonth.get("2030-03")?.balance_statement_clp).toBe(10_000);

    // 2030-04: final cuota (billed 20-mar) paid 10-abr → trailing zero month lands the series.
    const apr = byMonth.get("2030-04");
    expect(apr?.projected).toBe(true);
    expect(apr?.balance_statement_clp).toBe(0);
    expect(apr?.cupo_statement_clp).toBe(0);

    // Nothing beyond the landing month.
    expect(byMonth.has("2030-05")).toBe(false);
  });
});
