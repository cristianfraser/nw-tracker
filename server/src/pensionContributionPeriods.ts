/**
 * The payroll month(s) a pension / unemployment / APV contribution pays
 * (`pension_contribution_periods`, migration 223). Written where the contribution is written (the
 * AFP certificate read, the AFC certificate import, the AFP ledger rebuild); a payslip's
 * contributions are the movements whose period is the payslip's month.
 */
import { db } from "./db.js";

const RE_PERIOD = /^\d{4}-(0[1-9]|1[0-2])$/;

export function recordContributionPeriods(movementId: number, periods: readonly string[]): void {
  if (periods.length === 0) throw new Error(`contribution periods: movement ${movementId} pays no month`);
  const insert = db.prepare(`INSERT OR IGNORE INTO pension_contribution_periods (movement_id, period_month) VALUES (?, ?)`);
  for (const p of periods) {
    if (!RE_PERIOD.test(p)) throw new Error(`contribution periods: «${p}» is not a YYYY-MM month (movement ${movementId})`);
    insert.run(movementId, p);
  }
}

export type PeriodContribution = { movement_id: number; account_id: number; amount: number; occurred_on: string; periods: string[] };

/** The contributions that pay a month, on any account, with every month each one pays. */
export function contributionsForPeriod(periodMonth: string): PeriodContribution[] {
  const rows = db
    .prepare(
      `SELECT m.id AS movement_id, COALESCE(m.account_id, m.to_account_id) AS account_id, m.amount, m.occurred_on,
              (SELECT group_concat(p2.period_month) FROM pension_contribution_periods p2 WHERE p2.movement_id = m.id) AS periods
         FROM pension_contribution_periods p
         JOIN movements m ON m.id = p.movement_id
        WHERE p.period_month = ?
        ORDER BY m.occurred_on, m.id`
    )
    .all(periodMonth) as (Omit<PeriodContribution, "periods"> & { periods: string })[];
  return rows.map((r) => ({ ...r, periods: r.periods.split(",").sort() }));
}
