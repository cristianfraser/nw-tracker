/**
 * The installment gap fill (`ccInstallmentPaymentBackfill.ts`) on synthetic plans of a synthetic
 * card: which cuotas it infers, where it dates them, at what amount, and that it only ever
 * touches its own `synthetic:cuota-N` rows. Dates in 2087.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { db } from "./db.js";
import { backfillMissingInstallmentPaymentsForPlans } from "./ccInstallmentPaymentBackfill.js";

describe("backfillMissingInstallmentPaymentsForPlans", () => {
  let accountId = 0;
  let seq = 0;
  const plans: number[] = [];

  beforeAll(() => {
    const group = db.prepare(`SELECT id FROM asset_groups WHERE slug IN ('credit_card', 'credit_cards__credit_card') LIMIT 1`).get() as { id: number };
    accountId = Number(db.prepare(`INSERT INTO accounts (asset_group_id, name) VALUES (?, 'vitest installment gap fill')`).run(group.id).lastInsertRowid);
  });

  afterEach(() => {
    for (const id of plans.splice(0)) {
      db.prepare(`DELETE FROM cc_installment_payments WHERE purchase_id = ?`).run(id);
      db.prepare(`DELETE FROM cc_installment_purchases WHERE id = ?`).run(id);
    }
  });

  afterAll(() => {
    db.prepare(`DELETE FROM accounts WHERE id = ?`).run(accountId);
  });

  function plan(purchaseDate: string, total: number, cuotas: number): number {
    const id = Number(
      db
        .prepare(
          `INSERT INTO cc_installment_purchases (account_id, card_group, canonical_row_id, purchase_date, total_amount_clp, cuotas_totales, merchant)
           VALUES (?, 'A', ?, ?, ?, ?, 'VITEST GAP FILL')`
        )
        .run(accountId, `vitest-gap-${++seq}`, purchaseDate, total, cuotas).lastInsertRowid
    );
    plans.push(id);
    return id;
  }

  function payment(planId: number, payBy: string, amount: number, cuota: number | null, total: number | null = null): void {
    db.prepare(
      `INSERT INTO cc_installment_payments (purchase_id, pay_by_date, amount_clp, cuota_current, cuota_total, parser_row_id) VALUES (?, ?, ?, ?, ?, ?)`
    ).run(planId, payBy, amount, cuota, total, `vitest-real-${planId}-${payBy}`);
  }

  const rows = (planId: number) =>
    db
      .prepare(`SELECT pay_by_date, amount_clp, cuota_current, cuota_total, parser_row_id, source_pdf FROM cc_installment_payments WHERE purchase_id = ? ORDER BY cuota_current, pay_by_date`)
      .all(planId) as { pay_by_date: string; amount_clp: number; cuota_current: number | null; cuota_total: number; parser_row_id: string; source_pdf: string | null }[];

  it("fills the cuotas before the first one printed, spread from the purchase day", () => {
    const p = plan("2087-01-01", 60_000, 6);
    payment(p, "2087-03-10", 10_000, 3, 6);
    expect(backfillMissingInstallmentPaymentsForPlans([p])).toEqual({ inserted: 2 });
    // Noon 2087-01-01 → noon 2087-03-10 is 68 days: cuota 1 at 68/3 = 22 d 16 h (01-24 04:00 UTC),
    // cuota 2 at 45 d 8 h (02-15 20:00 UTC).
    // Only up to the last cuota printed (M = 3): 4..6 are not invented.
    expect(rows(p).map((r) => [r.cuota_current, r.pay_by_date, r.amount_clp, r.parser_row_id])).toEqual([
      [1, "2087-01-24", 10_000, "synthetic:cuota-1"],
      [2, "2087-02-15", 10_000, "synthetic:cuota-2"],
      [3, "2087-03-10", 10_000, `vitest-real-${p}-2087-03-10`],
    ]);
    expect(rows(p)[0]).toMatchObject({ cuota_total: 6, source_pdf: "synthetic-gap-fill" });
  });

  it("interpolates a gap between printed cuotas at their median amount, and moves off a day already taken", () => {
    const p = plan("2087-01-01", 40_000, 4);
    payment(p, "2087-01-10", 9_000, 1, 4);
    payment(p, "2087-04-10", 11_000, 4, 4);
    // A row with no cuota number still holds its day.
    payment(p, "2087-02-09", 500, null);
    expect(backfillMissingInstallmentPaymentsForPlans([p])).toEqual({ inserted: 2 });
    // 01-10 → 04-10 is 90 days: cuota 2 at 30 days (02-09, taken → 02-10), cuota 3 at 60 days (03-11).
    // Amount: median of 9.000 and 11.000 = 10.000.
    expect(rows(p).filter((r) => r.parser_row_id.startsWith("synthetic:")).map((r) => [r.cuota_current, r.pay_by_date, r.amount_clp])).toEqual([
      [2, "2087-02-10", 10_000],
      [3, "2087-03-11", 10_000],
    ]);
  });

  it("adds nothing to a plan whose every cuota up to the last printed is on file, finished or not", () => {
    const finished = plan("2087-01-01", 30_000, 3);
    for (const [k, d] of [[1, "2087-02-10"], [2, "2087-03-10"], [3, "2087-04-10"]] as const) payment(finished, d, 10_000, k, 3);
    const noNumbers = plan("2087-01-01", 30_000, 3);
    payment(noNumbers, "2087-02-10", 10_000, null);
    expect(backfillMissingInstallmentPaymentsForPlans([finished, noNumbers])).toEqual({ inserted: 0 });
    expect(rows(finished)).toHaveLength(3);
    expect(rows(noNumbers)).toHaveLength(1);
  });

  it("replaces its own earlier rows on a re-run and steps aside for a printed cuota that arrived", () => {
    const p = plan("2087-01-01", 30_000, 3);
    payment(p, "2087-04-10", 10_000, 3, 3);
    expect(backfillMissingInstallmentPaymentsForPlans([p, p])).toEqual({ inserted: 2 });
    expect(backfillMissingInstallmentPaymentsForPlans([p])).toEqual({ inserted: 2 });
    expect(rows(p)).toHaveLength(3);
    // The statement then prints cuota 2: only cuota 1 is still inferred, the real rows untouched.
    payment(p, "2087-03-10", 10_000, 2, 3);
    expect(backfillMissingInstallmentPaymentsForPlans([p])).toEqual({ inserted: 1 });
    expect(rows(p).map((r) => [r.cuota_current, r.parser_row_id.startsWith("synthetic:")])).toEqual([
      [1, true],
      [2, false],
      [3, false],
    ]);
  });

  it("caps at the plan's count", () => {
    // A printed cuota number beyond the count: M = min(3, 5) = 3, and with no printed cuota at or
    // under M to interpolate towards, every filled cuota sits from the purchase day on.
    const p = plan("2087-01-01", 90_000, 3);
    payment(p, "2087-06-10", 10_000, 5, 5);
    expect(backfillMissingInstallmentPaymentsForPlans([p])).toEqual({ inserted: 3 });
    expect(rows(p).filter((r) => r.parser_row_id.startsWith("synthetic:")).map((r) => [r.cuota_current, r.pay_by_date])).toEqual([
      [1, "2087-01-01"],
      [2, "2087-01-02"],
      [3, "2087-01-03"],
    ]);
    // At the printed cuota's amount, not 90.000 / 3 = 30.000.
    expect(rows(p)[0]!.amount_clp).toBe(10_000);
  });

  it("does nothing for no plans and refuses a plan that does not exist", () => {
    expect(backfillMissingInstallmentPaymentsForPlans([])).toEqual({ inserted: 0 });
    expect(() => backfillMissingInstallmentPaymentsForPlans([-1])).toThrow(/plan -1 not found/);
  });
});
