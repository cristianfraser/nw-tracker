/** The declared recurring payments (`recurring_payments` + their merchant patterns), as the matcher reads them. */
import { db } from "./db.js";
import type { RecurringEntry } from "./recurringPaymentMatch.js";

type RecurringRow = Omit<RecurringEntry, "manual" | "patterns"> & { manual: number };

const recurringRowsStmt = db.prepare(
  `SELECT id, name, detail, manual, frequency, due_month, due_day, amount, currency,
          match_days_before, match_days_after, amount_tolerance_pct, created_at
   FROM recurring_payments ORDER BY id`
);
const recurringPatternsStmt = db.prepare(
  `SELECT recurring_payment_id AS id, pattern FROM recurring_payment_patterns ORDER BY recurring_payment_id, pattern`
);

/** Every declared payment with its merchant patterns, in declaration order. */
export function listRecurringPayments(): RecurringEntry[] {
  const patterns = new Map<number, string[]>();
  for (const p of recurringPatternsStmt.all() as { id: number; pattern: string }[]) {
    patterns.set(p.id, [...(patterns.get(p.id) ?? []), p.pattern]);
  }
  return (recurringRowsStmt.all() as RecurringRow[]).map((r) => {
    const own = patterns.get(r.id);
    if (!own) throw new Error(`recurring payment ${r.id} has no merchant pattern`);
    return { ...r, manual: r.manual === 1, patterns: own };
  });
}
