/**
 * A line's value in a unit, as the server gave it (`FlowCcExpenseLineRow.converted`, in the unit the
 * lines were requested in, and `value_clp`, its pesos): the client never converts. A unit the line
 * has no value in reads as its own amount when the line is in that unit, else throws.
 */
import { isHomeCurrency } from "nw-tracker-contracts/dto/apiConstants";
import type { FlowCcExpenseLineRow } from "./types";

type MoneyLine = Pick<FlowCcExpenseLineRow, "amount" | "converted" | "value_clp">;

export function lineValueIn(line: MoneyLine, unit: string): number {
  if (line.converted && line.converted.currency === unit) return line.converted.value;
  if (line.amount.currency === unit) return line.amount.value;
  if (isHomeCurrency(unit)) return line.value_clp;
  throw new Error(`expense line has no value in ${unit}`);
}

/** The line's pesos (the facturado's frame), whatever unit the lines were requested in. */
export function linePesos(line: Pick<FlowCcExpenseLineRow, "value_clp">): number {
  return line.value_clp;
}

/** Σ of the lines' values in a unit. */
export function sumLineValues(lines: readonly MoneyLine[], unit: string): number {
  return lines.reduce((s, ln) => s + lineValueIn(ln, unit), 0);
}
