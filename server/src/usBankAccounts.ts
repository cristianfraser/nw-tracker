/**
 * The client's accounts at a US bank, read as data: a dollar account declared in
 * `bank_account_numbers` under an issuer listed in `US_BANK_ISSUERS` (`taxFacts/payers.ts`, beside
 * the brokers domiciled abroad). Their interest (`savings_earnings` rows) is US-source interest:
 * line 2b of the 1040 (`f1040Draft.ts`) and «otras rentas de fuente extranjera» on the F22
 * (`f22/foreignIncome.ts`). Never a name match.
 */
import { db } from "./db.js";
import { interestFacts } from "./taxFacts/interest.js";
import { isUsBankDollarPayer, US_BANK_ISSUERS } from "./taxFacts/payers.js";

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
  const lines = interestFacts({ fromYmd: `${year}-01-01`, throughYmd: `${year}-12-31` })
    .filter((f) => f.payers.some(isUsBankDollarPayer))
    .map((f): UsBankInterestLine => {
      if (f.currency !== "usd") throw new Error(`US bank interest: movement ${f.movementId} is in ${f.currency}, expected dollars`);
      return { date: f.date, movementId: f.movementId, accountId: f.accountId, usd: f.amount };
    });
  return { lines, usd: Math.round(lines.reduce((s, l) => s + l.usd, 0) * 100) / 100 };
}
