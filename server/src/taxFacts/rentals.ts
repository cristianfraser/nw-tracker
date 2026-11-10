/**
 * The places that earned rent in a window (`expense_accounts`, the credits the user marked as their
 * rent: `flow_income_overrides.income_kind = 'rent'`), each with what the ledger knows of it: every
 * rent credit, every bill row filed under the place (contribuciones, gastos comunes, utilities…),
 * its DFL-2 declaration, and the property and loan behind it (`accountRoles.ts`; the loan's payments
 * are `loans.ts`'). Pesos as stored, no reajuste, no exemption rule.
 *
 * The agency's commission is not here: it is a checking debit with no structured link to the place
 * (the demo files it under «bills» by the bank's wording), so no reader can tell whose it is.
 */
import { db } from "../db.js";
import type { DateWindow } from "../dateWindow.js";
import { loanAccountIdOfProperty } from "../accountRoles.js";
import { loadRentCreditsForYear, type RentCredit } from "../flowsCheckingIncomeOverrides.js";

export type RentCreditFact = { movementId: number; date: string; amountClp: number };

/** A bill row of the place (`expense_entries`), in pesos; `monthsCovered` > 1 when one payment covers several months. */
export type PlaceBillFact = { entryId: number; date: string; category: string | null; amountClp: number; monthsCovered: number };

export type RentalPlaceFact = {
  placeId: number;
  slug: string;
  label: string;
  /** The DFL-2 declaration (`dfl2` with its built m² and reception year, set together); null when not DFL-2. */
  dfl2: { builtM2: number | null; receptionYear: number | null } | null;
  /** The net-worth property account of an owned place; null for a rented one. */
  propertyAccountId: number | null;
  /** The property's mortgage (`loan_of`); null without one. */
  loanAccountId: number | null;
  /** The property's first appraisal on file (`valuations`, in the appraisal's unit: UF): what it was bought at when the ledger opens with the purchase. */
  firstAppraisal: { date: string; value: number; currency: string } | null;
  /** By date then movement id. */
  rentCredits: RentCreditFact[];
  /** Every bill row of the place dated in the window, in entry order. */
  bills: PlaceBillFact[];
};

type PlaceRow = {
  id: number;
  slug: string;
  label: string;
  dfl2: number;
  dfl2_built_m2: number | null;
  dfl2_reception_year: number | null;
  property_account_id: number | null;
};

/** The window's rented places, in the order of their first rent credit. */
export function rentalFacts(window: DateWindow): RentalPlaceFact[] {
  const firstYear = Number(window.fromYmd.slice(0, 4));
  const lastYear = Number(window.throughYmd.slice(0, 4));
  const credits: RentCredit[] = [];
  for (let y = firstYear; y <= lastYear; y++) {
    credits.push(...loadRentCreditsForYear(y).filter((c) => c.receivedOn >= window.fromYmd && c.receivedOn <= window.throughYmd));
  }
  const placeIds = [...new Set(credits.map((c) => c.placeId))];
  const placeStmt = db.prepare(
    `SELECT id, slug, label, dfl2, dfl2_built_m2, dfl2_reception_year, property_account_id FROM expense_accounts WHERE id = ?`
  );
  const billStmt = db.prepare(
    `SELECT id, spent_on, category, amount_clp, months_covered FROM expense_entries
      WHERE expense_account_id = ? AND spent_on >= ? AND spent_on <= ? ORDER BY id`
  );
  const appraisalStmt = db.prepare(
    `SELECT as_of_date, value, currency FROM valuations WHERE account_id = ? ORDER BY as_of_date, id LIMIT 1`
  );
  return placeIds.map((id): RentalPlaceFact => {
    const p = placeStmt.get(id) as PlaceRow | undefined;
    if (!p) throw new Error(`rent names place ${id}, which does not exist`);
    const appraisal =
      p.property_account_id == null
        ? undefined
        : (appraisalStmt.get(p.property_account_id) as { as_of_date: string; value: number; currency: string } | undefined);
    return {
      placeId: p.id,
      slug: p.slug,
      label: p.label,
      dfl2: p.dfl2 === 1 ? { builtM2: p.dfl2_built_m2, receptionYear: p.dfl2_reception_year } : null,
      propertyAccountId: p.property_account_id,
      loanAccountId: p.property_account_id == null ? null : loanAccountIdOfProperty(p.property_account_id),
      firstAppraisal: appraisal ? { date: appraisal.as_of_date, value: appraisal.value, currency: appraisal.currency } : null,
      rentCredits: credits
        .filter((c) => c.placeId === id)
        .map((c) => ({ movementId: c.movementId, date: c.receivedOn, amountClp: c.amountClp })),
      bills: (
        billStmt.all(id, window.fromYmd, window.throughYmd) as {
          id: number;
          spent_on: string;
          category: string | null;
          amount_clp: number;
          months_covered: number;
        }[]
      ).map((b) => ({ entryId: b.id, date: b.spent_on, category: b.category, amountClp: b.amount_clp, monthsCovered: b.months_covered })),
    };
  });
}
