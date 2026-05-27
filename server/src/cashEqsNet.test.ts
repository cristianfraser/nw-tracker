import { describe, expect, it } from "vitest";
import { db } from "./db.js";
import { chileCalendarTodayYmd } from "./chileDate.js";
import { linkedCreditCardClpForCashCardAsOf } from "./liabilityTree.js";
import { getDashboardValuationTimeseries } from "./valuationTimeseries.js";

describe("cash_eqs net in dashboard charts", () => {
  it("overview cash at today equals gross cash accounts minus linked credit cards", () => {
    const asOf = chileCalendarTodayYmd();
    const linked = linkedCreditCardClpForCashCardAsOf(asOf);
    if (linked <= 0) return;

    const grossRows = db
      .prepare(
        `SELECT v.value_clp
         FROM valuations v
         JOIN accounts a ON a.id = v.account_id
         JOIN categories c ON c.id = a.category_id
         JOIN asset_groups g ON g.id = c.group_id
         WHERE g.slug = 'cash_eqs'
           AND c.slug IN ('fondo_reserva', 'cuenta_corriente', 'cuenta_vista')
           AND COALESCE(a.exclude_from_group_totals, 0) = 0
           AND v.as_of_date = (
             SELECT MAX(v2.as_of_date) FROM valuations v2
             WHERE v2.account_id = v.account_id AND v2.as_of_date <= ?
           )`
      )
      .all(asOf) as { value_clp: number }[];
    if (!grossRows.length) return;
    const grossCash = grossRows.reduce((s, r) => s + r.value_clp, 0);

    const ts = getDashboardValuationTimeseries("clp");
    const pt = ts.overview.points.find((p) => String(p.as_of_date) === asOf);
    if (!pt || typeof pt.cash !== "number" || !Number.isFinite(pt.cash)) return;

    expect(pt.cash).toBeCloseTo(grossCash - linked, -2);
  });
});
