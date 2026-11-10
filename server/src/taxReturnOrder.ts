/**
 * Which return of an income year is computed first when both exist, so that the one that credits
 * the other's tax reads it (docs/demo-app-features-plan.md §5, review item 7):
 *
 * - a **Chilean-resident year** (the whole year, or undeclared): the Form 1040 first — the F22's
 *   foreign-salary credit reads its line 24 (`f22/foreignIncome.ts`);
 * - a **non-resident or split year**: the F22 first — the 1040's foreign tax credit (Form 1116,
 *   Schedule 3 line 1) reads Chile's tax on the same income.
 *
 * The one rule the demo generator's April loop and any reader that chains the two drafts follow.
 */
import { residencyForIncomeYear, type YearResidency } from "./taxResidency.js";

export type TaxReturnKind = "f1040" | "f22";

/** The order for a year's residency (pure). */
export function taxReturnOrderFor(r: YearResidency): TaxReturnKind[] {
  return r.cl === "full" ? ["f1040", "f22"] : ["f22", "f1040"];
}

/** The order of `incomeYear`'s two returns, from the declared residency. */
export function taxReturnOrder(incomeYear: number): TaxReturnKind[] {
  return taxReturnOrderFor(residencyForIncomeYear(incomeYear));
}

/**
 * Throws unless `reader`'s draft of `incomeYear` may read `read`'s: the one it reads must come
 * first in {@link taxReturnOrder} (the F22 of a Chilean-resident year reads the 1040's tax; the 1040
 * of a US-resident year reads Chile's). The two drafts call each other only through readers that
 * assert this, so neither can recurse into the other for the same year.
 */
export function assertReadsEarlierReturn(reader: TaxReturnKind, read: TaxReturnKind, incomeYear: number): void {
  const order = taxReturnOrder(incomeYear);
  if (order.indexOf(read) > order.indexOf(reader)) {
    throw new Error(
      `${reader === "f22" ? "F22" : "1040"} ${incomeYear} reads the ${read === "f22" ? "F22" : "1040"} of the same year, which comes after it (taxReturnOrder: ${order.join(" → ")})`
    );
  }
}
