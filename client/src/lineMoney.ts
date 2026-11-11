/**
 * A line's value in a unit, as the server gave it (`FlowCcExpenseLineRow.values`): the client never
 * converts. A unit the line has no value in reads as its own amount when the line is in that unit,
 * else throws (the server sends every display unit it has a rate for).
 */
import type { FlowCcExpenseLineRow } from "./types";

type MoneyLine = Pick<FlowCcExpenseLineRow, "amount" | "values">;

export function lineValueIn(line: MoneyLine, unit: string): number {
  const v = line.values[unit];
  if (v) return v.value;
  if (line.amount.currency === unit) return line.amount.value;
  throw new Error(`expense line has no value in ${unit}`);
}

/** Σ of the lines' values in a unit. */
export function sumLineValues(lines: readonly MoneyLine[], unit: string): number {
  return lines.reduce((s, ln) => s + lineValueIn(ln, unit), 0);
}
