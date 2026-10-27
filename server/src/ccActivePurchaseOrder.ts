import { parseYearMonth } from "./ccYearMonth.js";

/**
 * The fields of an active installment purchase the «Compras activas» order reads. Kept as a
 * structural subset of `CcInstallmentPurchaseComputed` so this module stays a leaf (no db).
 */
export type CcActivePurchaseOrderKey = {
  label: string;
  remaining_installments: number;
  /** Facturación month the first cuota bills (YYYY-MM); the plan's schedule anchor. */
  first_due_month: string;
};

/** The plan's first-cuota facturación month as YYYY-MM, or null when it carries none parseable. */
export function activePurchaseFirstDueYm(p: CcActivePurchaseOrderKey): string | null {
  return parseYearMonth(p.first_due_month);
}

function compareNullableYm(a: string | null, b: string | null): number {
  if (a === b) return 0;
  if (a == null) return 1;
  if (b == null) return -1;
  return a < b ? -1 : 1;
}

/**
 * «Compras activas (cuotas pendientes)» order:
 *
 * 1. `remaining_installments` ascending — the plan with the fewest cuotas left first.
 * 2. `first_due_month` ascending (a plan without one sorts last) — plans with the same count left
 *    read in the order their schedules bill, not by name.
 * 3. `label`, Spanish collation, so the order is stable and readable.
 */
export function compareActivePurchases(a: CcActivePurchaseOrderKey, b: CcActivePurchaseOrderKey): number {
  const byRemaining = a.remaining_installments - b.remaining_installments;
  if (byRemaining !== 0) return byRemaining;
  const byFirst = compareNullableYm(activePurchaseFirstDueYm(a), activePurchaseFirstDueYm(b));
  if (byFirst !== 0) return byFirst;
  return a.label.localeCompare(b.label, "es");
}

/** A new array of `purchases` in «Compras activas» order (the input is left as it is). */
export function sortActivePurchases<T extends CcActivePurchaseOrderKey>(purchases: readonly T[]): T[] {
  return [...purchases].sort(compareActivePurchases);
}
