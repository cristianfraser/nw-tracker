/**
 * Loan payments in a window: each mortgage payment's loan leg (`loan_payments.leg = 'loan'`), what
 * the bank states it paid, in the payment's currency — the principal, the extra principal, the
 * interest and the two insurances. No reajuste, no deduction rule. A property's loan is
 * `accountRoles.ts`' `loan_of`; a rental place names its property (`rentals.ts`).
 */
import { db } from "../db.js";
import type { DateWindow } from "../dateWindow.js";

export type LoanPaymentFact = {
  movementId: number;
  date: string;
  loanAccountId: number;
  /** The currency of every amount below (`loan_payments.payment_currency`). */
  currency: string;
  principal: number | null;
  extraPrincipal: number | null;
  interest: number | null;
  insuranceFire: number | null;
  insuranceLife: number | null;
};

/** The window's loan payments (every loan's, or `loanAccountId`'s), by date then movement id. */
export function loanPaymentFacts(window: DateWindow, loanAccountId?: number): LoanPaymentFact[] {
  return (
    db
      .prepare(
        `SELECT m.id, m.occurred_on, p.loan_account_id, p.payment_currency, p.principal, p.extra_principal, p.interest,
                p.insurance_fire, p.insurance_life
           FROM loan_payments p JOIN movements m ON m.id = p.movement_id
          WHERE p.leg = 'loan' AND m.occurred_on >= ? AND m.occurred_on <= ? AND (? IS NULL OR p.loan_account_id = ?)
          ORDER BY m.occurred_on, m.id`
      )
      .all(window.fromYmd, window.throughYmd, loanAccountId ?? null, loanAccountId ?? null) as {
      id: number;
      occurred_on: string;
      loan_account_id: number;
      payment_currency: string;
      principal: number | null;
      extra_principal: number | null;
      interest: number | null;
      insurance_fire: number | null;
      insurance_life: number | null;
    }[]
  ).map((r) => ({
    movementId: r.id,
    date: r.occurred_on,
    loanAccountId: r.loan_account_id,
    currency: r.payment_currency,
    principal: r.principal,
    extraPrincipal: r.extra_principal,
    interest: r.interest,
    insuranceFire: r.insurance_fire,
    insuranceLife: r.insurance_life,
  }));
}
