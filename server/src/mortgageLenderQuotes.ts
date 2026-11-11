/**
 * The mortgage lender's stored quotes (`mortgage_lender_quotes`, migration 308, written by
 * `mortgageLenderStatementApply.ts`) and the lookups the readers and the run scheduler share: the
 * loan a lender names, the latest quote of a cuota, what the scheduler asks before a MetLife read.
 */
import { addCalendarMonths } from "nw-tracker-contracts";
import { accountsWithRole, propertyLoanPairsWithLoan, storedRolesOfAccount } from "./accountRoles.js";
import { db } from "./db.js";
import type { DeptoMortgageSheetRow } from "./deptoDividendosLedger.js";
import { deptoLedgerForLoan } from "./deptoLedgerFromMovements.js";
import { numericCuota } from "./mortgagePaymentCompute.js";
import { firstMortgageScheduleYmd, mortgageScheduleYmdForCuota, type MortgageCuotaQuote } from "./mortgageScenarioPayments.js";

/** The loans whose `lender_pattern` words name lender `lender` (its slug, e.g. «metlife»). */
function loansOfLender(lender: string): number[] {
  const want = lender.trim().toUpperCase();
  const loans = new Set(propertyLoanPairsWithLoan().map((p) => p.loanAccountId));
  return accountsWithRole("lender_pattern").filter(
    (id) =>
      loans.has(id) &&
      storedRolesOfAccount(id).some((r) => r.role === "lender_pattern" && r.param.split(/\s+/).includes(want))
  );
}

/** The one loan of lender `lender`, or null when none; several throw. */
export function loanAccountIdForLenderOptional(lender: string): number | null {
  const ids = loansOfLender(lender);
  if (ids.length > 1) {
    throw new Error(`mortgage lender «${lender}»: ${ids.length} loans name it (${ids.join(", ")}) — expected one`);
  }
  return ids[0] ?? null;
}

/** The one loan of lender `lender`; none or several throw. */
export function loanAccountIdForLender(lender: string): number {
  const id = loanAccountIdForLenderOptional(lender);
  if (id == null) {
    throw new Error(`mortgage lender «${lender}»: no loan holds a lender_pattern naming it`);
  }
  return id;
}

export type StoredLenderQuote = {
  id: number;
  lender: string;
  credit_number: string;
  loan_account_id: number;
  cuota: number;
  due_on: string;
  fee_uf: number;
  fee_pesos: number;
  min_uf: number;
  min_pesos: number;
  max_uf: number;
  max_pesos: number;
  amortization_pesos: number;
  interest_pesos: number;
  default_interest_pesos: number;
  collection_fee_pesos: number;
  insurance_fire_uf: number | null;
  insurance_life_uf: number | null;
  insurance_other_uf: number | null;
  read_at: string;
  first_seen_at: string;
};

/** The latest stored quote of cuota `cuota` on loan `loanAccountId`, or null. */
export function mortgageLenderQuoteForCuota(loanAccountId: number, cuota: number): StoredLenderQuote | null {
  return (
    (db
      .prepare(`SELECT * FROM mortgage_lender_quotes WHERE loan_account_id = ? AND cuota = ? ORDER BY read_at DESC, id DESC LIMIT 1`)
      .get(loanAccountId, cuota) as StoredLenderQuote | undefined) ?? null
  );
}

/** The latest due day any stored quote of loan `loanAccountId` names, or null (the scheduler's question). */
export function latestMortgageLenderQuoteDueOn(loanAccountId: number): string | null {
  const r = db.prepare(`SELECT MAX(due_on) AS d FROM mortgage_lender_quotes WHERE loan_account_id = ?`).get(loanAccountId) as {
    d: string | null;
  };
  return r.d ?? null;
}

/**
 * The month (YYYY-MM) the ledger's last regular cuota on its schedule was due in: cuota N is
 * scheduled the 11th of month S (`mortgageScenarioPayments.ts`, counted from the first cuota) and
 * due by the 10th of S + 1 (`mortgageCuotaDay.ts`). Null when the ledger has no regular cuota.
 */
export function lastLedgerCuotaDueMonth(ledger: readonly DeptoMortgageSheetRow[]): string | null {
  const numeric = ledger.map((r) => numericCuota(r.cuota)).filter((n): n is number => n != null);
  const first = firstMortgageScheduleYmd(ledger);
  if (numeric.length === 0 || !first) return null;
  const schedule = mortgageScheduleYmdForCuota(first, Math.min(...numeric), Math.max(...numeric));
  if (!schedule) return null;
  return addCalendarMonths(schedule.slice(0, 7), 1);
}

/** The lender whose portal the `metlife_read` request reads. */
export const METLIFE_LENDER = "metlife";

/** What `decideMetlifeRead` needs from the database (all but the clock and the last request). */
export function metlifeReadInputs(): {
  hasLoan: boolean;
  latestQuoteDueOn: string | null;
  ledgerLastDueMonth: string | null;
  receipts: { due_on: string; paid_on: string }[];
} {
  const loanId = loanAccountIdForLenderOptional(METLIFE_LENDER);
  if (loanId == null) return { hasLoan: false, latestQuoteDueOn: null, ledgerLastDueMonth: null, receipts: [] };
  const receipts = db
    .prepare(`SELECT due_on, paid_on FROM mortgage_payment_receipts WHERE lender = ? ORDER BY due_on`)
    .all(METLIFE_LENDER) as { due_on: string; paid_on: string }[];
  return {
    hasLoan: true,
    latestQuoteDueOn: latestMortgageLenderQuoteDueOn(loanId),
    ledgerLastDueMonth: lastLedgerCuotaDueMonth(deptoLedgerForLoan(loanId)),
    receipts,
  };
}

/**
 * The lender's quote of the cuota after the ledger's last regular one on loan `loanAccountId`, as
 * the scenario table and «Próximos pagos» read it; null when none is stored.
 */
export function nextCuotaQuoteForLoan(loanAccountId: number, ledger: readonly DeptoMortgageSheetRow[]): MortgageCuotaQuote | null {
  const numeric = ledger.map((r) => numericCuota(r.cuota)).filter((n): n is number => n != null);
  if (numeric.length === 0) return null;
  const next = Math.max(...numeric) + 1;
  const q = mortgageLenderQuoteForCuota(loanAccountId, next);
  return q ? { cuota: q.cuota, min_uf: q.min_uf, max_uf: q.max_uf } : null;
}
