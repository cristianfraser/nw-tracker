import { currencySymbol, formatCompactMoney, formatGroupedDecimal, formatMoney, formatPct } from "../../format";
import { formatYearMonthLabel, formatMonthShortLabel } from "../../formatDateLabel";

/**
 * Formatting for the property and mortgage pages (`DeptoAccountDetailPage`). Every figure is the
 * server's (`depto_glance`); figures print through `formatMoney` / `formatCurrency` (the currency's
 * own row says its symbol and decimals), only axis ticks are bare.
 */

/** «+» / «−» by sign (a real minus), nothing at zero. */
export function signOf(n: number): string {
  return n > 0 ? "+" : n < 0 ? "−" : "";
}

/** The tone class key of a signed figure. */
export function toneOf(n: number | null | undefined): "pos" | "neg" | null {
  if (n == null || n === 0) return null;
  return n > 0 ? "pos" : "neg";
}

/** A loan-currency figure bare and whole: an axis tick («2.500», «300»); the end figure names the unit. */
export function loanWholeBare(n: number): string {
  return formatGroupedDecimal(Math.round(n), 0);
}

/** A signed amount through `formatMoney`, the sign written out: «+$12.345», «−1,50 UF». */
export function signedMoney(n: number, currency: string): string {
  return `${signOf(n)}${formatMoney({ value: Math.abs(n), currency })}`;
}

/** A fraction as a percent with one decimal: 0.425 → «42,5%». */
export function pct1(share: number): string {
  return formatPct(share * 100, 1);
}

/** A signed fraction as a percent with one decimal: «+5,2%», «−0,8%». */
export function pct1Signed(share: number): string {
  return `${signOf(share)}${formatPct(Math.abs(share) * 100, 1)}`;
}

/** A fraction as a percent with no decimals: «39%». */
export function pct0(share: number): string {
  return formatPct(share * 100, 0);
}

/** An axis figure in short notation without its symbol («500k», «1M»): the page names the unit. */
export function axisCompact(n: number, unit: string): string {
  return formatCompactMoney(n, unit).replace(currencySymbol(unit, "bare"), "");
}

/** Years with one decimal, whole years bare: 12.34 → «12,3», 30 → «30». */
export function years1(n: number): string {
  return Number.isInteger(n) ? formatGroupedDecimal(n, 0) : formatGroupedDecimal(n, 1);
}

/** A month tick: the month alone, or with its year on January and on the first tick. */
export function monthTickLabel(ym: string, withYear: boolean): string {
  return withYear ? formatYearMonthLabel(ym) : formatMonthShortLabel(ym);
}
