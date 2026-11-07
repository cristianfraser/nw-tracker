/**
 * When the mortgage cuota of a cycle is payable: from the 11th of the cycle month (the day the
 * bank posts it) through the day before the next cycle's, the 10th of the next month. One
 * constant for every reader — the UF reminder, «Próximos pagos», the mortgage-sheet run rule and
 * the demo. A leaf: no imports.
 */
export const MORTGAGE_CUOTA_DAY = 11;

/** The last day of a cycle's payment window: the day before the next cycle's cuota day. */
export const MORTGAGE_WINDOW_END_DAY = MORTGAGE_CUOTA_DAY - 1;

function nextMonth(month: string): string {
  const y = Number(month.slice(0, 4));
  const m = Number(month.slice(5, 7));
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, "0")}`;
}

const dd = (n: number) => String(n).padStart(2, "0");

/** The payment window of the cycle `cycleMonth` (YYYY-MM), as ISO dates. */
export function mortgageCuotaWindow(cycleMonth: string): { start: string; end: string } {
  return { start: `${cycleMonth}-${dd(MORTGAGE_CUOTA_DAY)}`, end: `${nextMonth(cycleMonth)}-${dd(MORTGAGE_WINDOW_END_DAY)}` };
}
