/**
 * Figures of a loan ledger payload (`nw-tracker-contracts/dto/mortgage`). The payload names the
 * currency of each figure by its role — `loan_currency` for the `_loan` keys, `payment_currency`
 * for the `_pay` keys — and a view formats a figure with the currency its row carries, never with
 * a formatter named after one.
 */
import { formatMoney, formatUfUnits, formatUfUnitsFine } from "./format";

/**
 * `value` in `currency`: money through `formatMoney`; the UF as units («1.234,5678 UF»), up to 4
 * decimals, or up to 2 when `precision` is `coarse` (a balance).
 */
export function formatLoanFigure(value: number, currency: string, precision: "fine" | "coarse" = "fine"): string {
  if (currency === "uf") return precision === "coarse" ? formatUfUnits(value) : formatUfUnitsFine(value); // convention-ok: the UF is an index shown as UF units, not with a money symbol
  return formatMoney({ value, currency });
}
