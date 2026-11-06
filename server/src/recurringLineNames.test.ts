import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { db } from "./db.js";
import { UNCLASSIFIED_CC_EXPENSE_SLUG } from "./ccExpenseCategories.js";
import { addDays } from "./recurringPaymentMatch.js";
import { withRecurringPaymentNames } from "./recurringLineNames.js";
import { ufProjector } from "./ufProjection.js";

const NAME = "vitest-recurring-line-names";

describe("withRecurringPaymentNames", () => {
  let entryId = 0;
  beforeEach(() => {
    const r = db
      .prepare(
        `INSERT INTO recurring_payments (name, manual, frequency, due_month, due_day, amount, currency, match_days_before, match_days_after, amount_tolerance_pct, created_at)
         VALUES (?, 0, 'monthly', NULL, 6, 0.5, 'uf', 14, 7, 0.5, ?)`
      )
      .run(NAME, `${ufProjector().knownThrough} 00:00:00`);
    entryId = Number(r.lastInsertRowid);
    for (const p of ["VITEST PENDING", "VITEST SETTLED"]) {
      db.prepare(`INSERT INTO recurring_payment_patterns (recurring_payment_id, pattern) VALUES (?, ?)`).run(entryId, p);
    }
  });
  afterEach(() => {
    db.prepare(`DELETE FROM recurring_payments WHERE name = ?`).run(NAME);
  });

  it("names a pending listing by the entry and gives it the category of the entry's last charge", () => {
    const uf = ufProjector();
    const month = addDays(uf.knownThrough, -60).slice(0, 7);
    const settledOn = `${month}-06`;
    const pendingOn = `${month}-03`;
    const pesos = Math.round(0.5 * uf.ufOn(settledOn));
    const line = (n: number, on: string, merchant: string, category_slug: string, fromBank: boolean, amount = pesos) => ({
      source: "cc",
      statement_line_id: n,
      purchase_key: `k${n}`,
      purchase_on: on,
      merchant,
      amount_clp: amount,
      category_slug,
      ...(fromBank ? { category_from_bank_name: true as const } : {}),
      recurring_payment: undefined as { id: number; name: string } | undefined,
    });
    const out = withRecurringPaymentNames([
      line(1, settledOn, "VITEST SETTLED", "transportation", true),
      line(2, pendingOn, "VITEST PENDING", UNCLASSIFIED_CC_EXPENSE_SLUG, true),
      line(3, pendingOn, "VITEST PENDING", UNCLASSIFIED_CC_EXPENSE_SLUG, true, pesos + 5_000),
    ]);
    expect(out[1]).toMatchObject({ recurring_payment: { id: entryId, name: NAME }, category_slug: "transportation" });
    // Same name, another amount: some other charge.
    expect(out[2]!.recurring_payment).toBeUndefined();
    expect(out[2]!.category_slug).toBe(UNCLASSIFIED_CC_EXPENSE_SLUG);
  });
});
