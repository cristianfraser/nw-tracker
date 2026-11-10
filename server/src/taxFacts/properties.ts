/**
 * The properties the user owns, as a tax reader needs them (a depreciation schedule, a cost basis):
 * when each was bought and for how much, the loan behind it, the tracked places linked to it with
 * their occupancy, the day its first rent arrived (a rental's placed-in-service date) and, for a
 * property that was the owner's home first, the day it became a rental and what it was worth then.
 * Native currency (the appraisal's: UF), no conversion, no rule of any country.
 *
 * What is used, because nothing else is recorded:
 * - **Purchase** = the property account's first appraisal (`valuations`, UF): the ledger opens it with
 *   the purchase price on the day of the pie. A property with no appraisal has no purchase.
 * - **Home converted to rental** = the first rent credit comes more than {@link HOME_CONVERSION_MIN_GAP_DAYS}
 *   days after the purchase. No fact says the owner lived there; a longer gap than a tenant search
 *   needs is the only evidence the ledger holds. The value at conversion is the appraisal in force
 *   on the day of the first rent (the latest on or before it).
 */
import { db } from "../db.js";
import { loanAccountIdOfProperty, propertyAccountIds } from "../accountRoles.js";

/** Days between the purchase and the first rent above which the property is read as a converted home. */
export const HOME_CONVERSION_MIN_GAP_DAYS = 62;

export type PropertyPlaceFact = {
  placeId: number;
  slug: string;
  label: string;
  /** `YYYY-MM` the place is tracked from / to (`expense_accounts.active_from` / `active_to`); null when open. */
  activeFrom: string | null;
  activeTo: string | null;
  /** The date of the first rent credit marked as the place's rent (all time); null when none. */
  firstRentDate: string | null;
};

export type PropertyAmountFact = { date: string; value: number; currency: string };

export type PropertyFact = {
  propertyAccountId: number;
  accountName: string;
  loanAccountId: number | null;
  /** The first appraisal on file: the price at the pie's day, in the appraisal's currency (UF). */
  purchase: PropertyAmountFact | null;
  /** The places linked to this property, by id. */
  places: PropertyPlaceFact[];
  /** The earliest first-rent date of its places: when it started earning rent. */
  placedInServiceDate: string | null;
  /** Set when the property was a home before it was rented: the conversion day and the appraisal in force then. */
  conversion: { date: string; appraisal: PropertyAmountFact } | null;
};

function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
}

/** Every property account with its purchase, places, first rent and conversion, by account id. */
export function propertyFacts(): PropertyFact[] {
  const nameStmt = db.prepare(`SELECT name FROM accounts WHERE id = ?`);
  const firstAppraisal = db.prepare(`SELECT as_of_date, value, currency FROM valuations WHERE account_id = ? ORDER BY as_of_date, id LIMIT 1`);
  const appraisalOnOrBefore = db.prepare(
    `SELECT as_of_date, value, currency FROM valuations WHERE account_id = ? AND as_of_date <= ? ORDER BY as_of_date DESC, id DESC LIMIT 1`
  );
  const placeStmt = db.prepare(
    `SELECT id, slug, label, active_from, active_to FROM expense_accounts WHERE property_account_id = ? ORDER BY id`
  );
  const firstRentStmt = db.prepare(
    `SELECT MIN(m.occurred_on) AS d FROM flow_income_overrides o JOIN movements m ON m.flow_id = o.flow_id
      WHERE o.income_kind = 'rent' AND o.is_excluded = 0 AND o.rent_place_id = ?`
  );
  const asFact = (r: { as_of_date: string; value: number; currency: string }): PropertyAmountFact => ({ date: r.as_of_date, value: r.value, currency: r.currency });
  return propertyAccountIds().map((id): PropertyFact => {
    const purchaseRow = firstAppraisal.get(id) as { as_of_date: string; value: number; currency: string } | undefined;
    const purchase = purchaseRow ? asFact(purchaseRow) : null;
    const places = (placeStmt.all(id) as { id: number; slug: string; label: string; active_from: string | null; active_to: string | null }[]).map(
      (p): PropertyPlaceFact => ({
        placeId: p.id,
        slug: p.slug,
        label: p.label,
        activeFrom: p.active_from || null,
        activeTo: p.active_to || null,
        firstRentDate: (firstRentStmt.get(p.id) as { d: string | null }).d,
      })
    );
    const rentDates = places.flatMap((p) => (p.firstRentDate ? [p.firstRentDate] : [])).sort();
    const placedInServiceDate = rentDates[0] ?? null;
    let conversion: PropertyFact["conversion"] = null;
    if (purchase && placedInServiceDate && daysBetween(purchase.date, placedInServiceDate) > HOME_CONVERSION_MIN_GAP_DAYS) {
      const inForce = appraisalOnOrBefore.get(id, placedInServiceDate) as { as_of_date: string; value: number; currency: string } | undefined;
      if (!inForce) throw new Error(`property ${id}: no appraisal on or before its conversion day ${placedInServiceDate}`);
      conversion = { date: placedInServiceDate, appraisal: asFact(inForce) };
    }
    return {
      propertyAccountId: id,
      accountName: (nameStmt.get(id) as { name: string }).name,
      loanAccountId: loanAccountIdOfProperty(id),
      purchase,
      places,
      placedInServiceDate,
      conversion,
    };
  });
}

/** The property's appraisal in force on `ymd` (the latest on or before it), or null before its first. */
export function propertyAppraisalOn(propertyAccountId: number, ymd: string): PropertyAmountFact | null {
  const r = db
    .prepare(`SELECT as_of_date, value, currency FROM valuations WHERE account_id = ? AND as_of_date <= ? ORDER BY as_of_date DESC, id DESC LIMIT 1`)
    .get(propertyAccountId, ymd) as { as_of_date: string; value: number; currency: string } | undefined;
  return r ? { date: r.as_of_date, value: r.value, currency: r.currency } : null;
}
