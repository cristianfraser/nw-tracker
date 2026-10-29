import { addCalendarMonths, parseYearMonth } from "./ccYearMonth.js";

/**
 * The fields of an active installment purchase the «Compras activas» order reads. Kept as a
 * structural subset of `CcInstallmentPurchaseComputed` so this module stays a leaf (no db).
 */
export type CcActivePurchaseOrderKey = {
  label: string;
  remaining_installments: number;
  installment_count: number;
  /** Facturación month the first cuota bills (YYYY-MM); the plan's schedule anchor. */
  first_due_month: string;
};

/** The plan's first-cuota facturación month as YYYY-MM, or null when it carries none parseable. */
export function activePurchaseFirstDueYm(p: CcActivePurchaseOrderKey): string | null {
  return parseYearMonth(p.first_due_month);
}

/**
 * The facturación month the plan's last cuota bills (YYYY-MM): first-cuota month + count − 1.
 * Known from the schedule alone, whatever statements have printed so far; null without a
 * parseable first-cuota month or a count.
 */
export function activePurchaseLastDueYm(p: CcActivePurchaseOrderKey): string | null {
  const first = activePurchaseFirstDueYm(p);
  if (first == null || p.installment_count <= 0) return null;
  return addCalendarMonths(first, p.installment_count - 1);
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
 * 2. The month the last cuota bills ascending (a plan without one sorts last): the schedule's
 *    end, known from the purchase whatever statements have printed — two plans the count puts
 *    together read in the order they finish (the count moves with each statement; a 00/N row once
 *    stored as cuota 0 shifted it, 2026-10-28).
 * 3. `first_due_month` ascending (a plan without one sorts last) — plans that also end together
 *    read in the order their schedules start, not by name.
 * 4. `label`, Spanish collation, so the order is stable and readable.
 */
export function compareActivePurchases(a: CcActivePurchaseOrderKey, b: CcActivePurchaseOrderKey): number {
  const byRemaining = a.remaining_installments - b.remaining_installments;
  if (byRemaining !== 0) return byRemaining;
  const byLast = compareNullableYm(activePurchaseLastDueYm(a), activePurchaseLastDueYm(b));
  if (byLast !== 0) return byLast;
  const byFirst = compareNullableYm(activePurchaseFirstDueYm(a), activePurchaseFirstDueYm(b));
  if (byFirst !== 0) return byFirst;
  return a.label.localeCompare(b.label, "es");
}

/** A new array of `purchases` in «Compras activas» order (the input is left as it is). */
export function sortActivePurchases<T extends CcActivePurchaseOrderKey>(purchases: readonly T[]): T[] {
  return [...purchases].sort(compareActivePurchases);
}

/**
 * A facturación's cuota lines in the «Compras activas» order, so the «Cuotas por facturación»
 * detail reads the plans as that table does: each line takes its plan's place in the plans sorted
 * by {@link compareActivePurchases}; a plan's own lines keep cuota order. A line naming a plan
 * not in `plans` throws.
 */
export function sortCuotaLinesInActiveOrder<L extends { purchase_id: string; installment_index: number }>(
  lines: readonly L[],
  plans: readonly (CcActivePurchaseOrderKey & { purchase_id: string })[]
): L[] {
  const rank = new Map<string, number>();
  sortActivePurchases(plans).forEach((p, i) => {
    if (!rank.has(p.purchase_id)) rank.set(p.purchase_id, i);
  });
  const ranked = lines.map((line) => {
    const r = rank.get(line.purchase_id);
    if (r == null) throw new Error(`cuota line names plan ${line.purchase_id}, not among the card's plans`);
    return { line, r };
  });
  return ranked
    .sort((a, b) => a.r - b.r || a.line.installment_index - b.line.installment_index)
    .map(({ line }) => line);
}
