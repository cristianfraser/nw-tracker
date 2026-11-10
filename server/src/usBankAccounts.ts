/**
 * The client's accounts at a US bank, read as data: a dollar account declared in
 * `bank_account_numbers` under an issuer listed in {@link US_BANK_ISSUERS} (the way the F22 names
 * its foreign brokers, `FOREIGN_BROKERS`). Their interest (`savings_earnings` rows) is US-source
 * interest: line 2b of the 1040 (`f1040Draft.ts`) and «otras rentas de fuente extranjera» on the
 * F22 (`f22ForeignIncome.ts`). Never a name match. A leaf: database reads only.
 */
import { db } from "./db.js";

/** The fictional Texas bank of the demo person (its checking and savings accounts). */
export const DEMO_US_BANK_ISSUER = "demo_bank_texas";

/** `bank_account_numbers.issuer` values that are US banks. */
export const US_BANK_ISSUERS: readonly string[] = [DEMO_US_BANK_ISSUER];

const issuerPlaceholders = () => US_BANK_ISSUERS.map(() => "?").join(", ");

/** Every dollar account declared at a US bank, ascending by id (empty without one). */
export function usBankDollarAccountIds(): number[] {
  const rows = db
    .prepare(`SELECT DISTINCT account_id FROM bank_account_numbers WHERE currency = 'usd' AND issuer IN (${issuerPlaceholders()}) ORDER BY account_id`)
    .all(...US_BANK_ISSUERS) as { account_id: number }[];
  return rows.map((r) => r.account_id);
}

export type UsBankInterestLine = { date: string; movementId: number; accountId: number; usd: number };
export type UsBankInterest = { lines: UsBankInterestLine[]; usd: number };

/** The interest the US bank accounts paid in `year` (every `savings_earnings` row on them, in dollars; another currency throws). */
export function usBankInterestForYear(year: number): UsBankInterest {
  const rows = db
    .prepare(
      `SELECT m.id, m.account_id, m.occurred_on, m.amount, m.currency FROM movements m
        WHERE m.flow_kind = 'savings_earnings' AND m.occurred_on LIKE ?
          AND m.account_id IN (SELECT account_id FROM bank_account_numbers WHERE currency = 'usd' AND issuer IN (${issuerPlaceholders()}))
        ORDER BY m.occurred_on, m.id`
    )
    .all(`${year}-%`, ...US_BANK_ISSUERS) as { id: number; account_id: number; occurred_on: string; amount: number; currency: string }[];
  const lines = rows.map((r): UsBankInterestLine => {
    if (r.currency !== "usd") throw new Error(`US bank interest: movement ${r.id} is in ${r.currency}, expected dollars`);
    return { date: r.occurred_on, movementId: r.id, accountId: r.account_id, usd: r.amount };
  });
  return { lines, usd: Math.round(lines.reduce((s, l) => s + l.usd, 0) * 100) / 100 };
}
