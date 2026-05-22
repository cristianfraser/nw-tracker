import { describe, expect, it } from "vitest";
import { checkingMovementBalanceAtMonthEnd } from "./checkingCartolaBalances.js";
import { getCheckingCartolaMonths } from "./checkingCartolaMonthSummary.js";
import { db } from "./db.js";

describe("getCheckingCartolaMonths", () => {
  it("returns rows for cuenta corriente account with imports", () => {
    const row = db
      .prepare(
        `SELECT a.id FROM accounts a
         JOIN categories c ON c.id = a.category_id
         WHERE c.slug = 'cuenta_corriente' LIMIT 1`
      )
      .get() as { id: number } | undefined;
    if (!row) return;
    const payload = getCheckingCartolaMonths(row.id);
    expect(payload).not.toBeNull();
    expect(payload!.rows.length).toBeGreaterThan(0);
    const apr = payload!.rows.find((r) => r.period_month === "2026-04");
    expect(apr?.has_cartola).toBe(true);
    expect(apr?.balance_end_clp).toBe(checkingMovementBalanceAtMonthEnd(row.id, "2026-04"));
    expect(apr!.deposits_clp).toBeGreaterThan(0);
    expect(apr!.withdrawals_clp).toBeGreaterThan(0);
    const months = payload!.rows.map((r) => r.period_month);
    if (months.includes("2020-05") && months.includes("2020-07")) {
      expect(months).toContain("2020-06");
    }
  });

  it("returns null for non-checking accounts", () => {
    const row = db
      .prepare(
        `SELECT a.id FROM accounts a
         JOIN categories c ON c.id = a.category_id
         WHERE c.slug = 'fondo_reserva' LIMIT 1`
      )
      .get() as { id: number } | undefined;
    if (!row) return;
    expect(getCheckingCartolaMonths(row.id)).toBeNull();
  });
});
