import { describe, expect, it } from "vitest";
import { cuotaProgressForPurchase } from "./ccInstallmentLedgerDb.js";

const row = (cuota: number, statementMonth: string, amount: number, opts?: { statement?: string; payBy?: string }) => ({
  id: cuota,
  purchase_id: 7,
  pay_by_date: opts?.payBy ?? `${statementMonth}-09`,
  statement_date: opts?.statement ?? null,
  statement_period_month: statementMonth,
  period_to_join: null,
  source_pdf: "x.pdf",
  amount_clp: amount,
  cuota_current: cuota,
  cuota_total: 6,
});

/** Paid when its pay-by is on or before «today» (2026-10-28). */
const paidByToday = (_month: string, payBy: string | null) => payBy != null && payBy <= "2026-10-28";

describe("cuotaProgressForPurchase", () => {
  it("lists every cuota of the plan: printed ones with their statement, the rest from the schedule", () => {
    const plan = {
      installmentCount: 6,
      firstDueYm: "2026-05",
      cuotaAmounts: [82_000, 82_000, 82_000, 82_000, 82_000, 82_000],
      installmentsPaid: 5,
    };
    const pays = [
      row(1, "2026-05", 82_000, { statement: "25/05/2026", payBy: "2026-06-09" }),
      row(2, "2026-06", 82_000, { statement: "23/06/2026", payBy: "2026-07-09" }),
      row(3, "2026-07", 82_000, { statement: "23/07/2026", payBy: "2026-08-10" }),
      row(4, "2026-08", 82_000, { statement: "25/08/2026", payBy: "2026-09-09" }),
      row(5, "2026-09", 82_000, { statement: "24/09/2026", payBy: "2026-10-09" }),
    ];
    const p = cuotaProgressForPurchase(plan, pays, paidByToday);
    expect(p.cuotas.map((c) => [c.index, c.billing_month, c.status])).toEqual([
      [1, "2026-05", "paid"],
      [2, "2026-06", "paid"],
      [3, "2026-07", "paid"],
      [4, "2026-08", "paid"],
      [5, "2026-09", "paid"],
      [6, "2026-10", "pending"],
    ]);
    expect(p.cuotas[0]).toMatchObject({ statement_date: "2026-05-25", pay_by_date: "2026-06-09", amount_clp: 82_000 });
    expect(p.cuotas[5]).toMatchObject({ statement_date: null, pay_by_date: null, amount_clp: 82_000 });
    expect(p.paid_count).toBe(5);
    expect(p.paid_clp).toBe(410_000);
    expect(p.billed_clp).toBe(0);
    expect(p.pending_clp).toBe(82_000);
    expect(p.total_clp).toBe(492_000);
  });

  it("a printed cuota whose facturación is not paid yet is billed; printed amounts win over the split", () => {
    const plan = {
      installmentCount: 3,
      firstDueYm: "2026-08",
      cuotaAmounts: [400_000, 400_000, 400_000],
      installmentsPaid: 1,
    };
    const pays = [row(1, "2026-08", 400_000), row(2, "2026-09", 400_002, { payBy: "2026-11-10" })];
    const p = cuotaProgressForPurchase(plan, pays, paidByToday);
    expect(p.cuotas.map((c) => c.status)).toEqual(["paid", "billed", "pending"]);
    expect(p.cuotas[1]!.amount_clp).toBe(400_002);
    expect(p.billed_clp).toBe(400_002);
    expect(p.pending_clp).toBe(400_000);
    expect(p.total_clp).toBe(p.paid_clp + p.billed_clp + p.pending_clp);
  });

  it("a cuota the schedule counts billed stays billed until its facturación is paid (2026-10-28)", () => {
    // The October statement printed the last cuota (close 26/10, pay-by 10/11): billed, not paid.
    const plan = { installmentCount: 2, firstDueYm: "2026-09", cuotaAmounts: [82_000, 82_000], installmentsPaid: 2 };
    const pays = [
      row(1, "2026-09", 82_000, { statement: "24/09/2026", payBy: "2026-10-09" }),
      row(2, "2026-10", 82_000, { statement: "26/10/2026", payBy: "2026-11-10" }),
    ];
    const p = cuotaProgressForPurchase(plan, pays, paidByToday);
    expect(p.cuotas.map((c) => c.status)).toEqual(["paid", "billed"]);
    expect(p.paid_count).toBe(1);
    expect(p.billed_clp).toBe(82_000);
  });

  it("collapses a duplicate statement copy of a cuota, and throws on a differing twin or an index above N", () => {
    const plan = { installmentCount: 2, firstDueYm: "2026-01", cuotaAmounts: [10, 10], installmentsPaid: 1 };
    const dup = [row(1, "2026-01", 10), { ...row(1, "2026-01", 10), id: 99, pay_by_date: "2026-02-10" }];
    expect(cuotaProgressForPurchase(plan, dup, paidByToday).cuotas).toHaveLength(2);
    expect(() =>
      cuotaProgressForPurchase(plan, [row(1, "2026-01", 10), { ...row(1, "2026-01", 11), id: 99 }], paidByToday)
    ).toThrow(/twice/);
    expect(() => cuotaProgressForPurchase(plan, [row(3, "2026-03", 10)], paidByToday)).toThrow(/cuota 3 of a 2-cuota plan/);
  });
});
