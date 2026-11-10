/**
 * A closed range of ISO days, `fromYmd` through `throughYmd` inclusive. The F22 draft hands one
 * to every loader of a year's items so the departure year (a declared tax residency that changes
 * mid-year, `taxResidency.ts`) can be computed in two parts: the resident part through the declared
 * day, the non-resident part from the next day. A leaf: no imports.
 */
export type DateWindow = { fromYmd: string; throughYmd: string };

export function wholeYearWindow(year: number): DateWindow {
  return { fromYmd: `${year}-01-01`, throughYmd: `${year}-12-31` };
}

export function inDateWindow(ymd: string, window: DateWindow): boolean {
  return ymd >= window.fromYmd && ymd <= window.throughYmd;
}

/** The window's months as `YYYY-MM` bounds (a payslip is keyed by its period month). */
export function windowMonths(window: DateWindow): { fromMonth: string; throughMonth: string } {
  return { fromMonth: window.fromYmd.slice(0, 7), throughMonth: window.throughYmd.slice(0, 7) };
}
