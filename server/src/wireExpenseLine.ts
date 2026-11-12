/**
 * The expense line as it goes over the wire: its money is `amount` (the currency it happened in),
 * `converted` (its value in the requested display unit, `lineMoney.ts`) and `value_clp` (its pesos,
 * the facturado's frame); the builders' peso and dollar fields (`amount_clp`, `amount_usd`,
 * `amount_usd_at_expense`, `clp_rate_source`) and the internal `values` stay inside the server.
 * Every route that sends lines sends them through this. Typed structurally (no import of the server
 * line type) so the line builders can use it without an import cycle.
 */
import type { FlowCcExpenseLineRow as WireExpenseLine, LineUnitValue } from "nw-tracker-contracts/dto/flows";
import { lineAmount, lineConvertedForWire, linePesos } from "./lineMoney.js";

type ServerLine = {
  amount_clp: number;
  amount_usd?: number | null;
  amount_usd_at_expense?: number | null;
  clp_rate_source?: unknown;
  amount?: { value: number; currency: string };
  values?: Record<string, LineUnitValue>;
  occurred_on?: string;
  purchase_on?: string | null;
};

export function toWireExpenseLine(l: ServerLine, unit: string): WireExpenseLine {
  lineAmount(l); // throws on a line the «line money» step has not seen
  const converted = lineConvertedForWire(l, unit);
  const value_clp = linePesos(l);
  const { amount_clp: _c, amount_usd: _u, amount_usd_at_expense: _e, clp_rate_source: _r, values: _v, ...wire } = l;
  return { ...wire, converted, value_clp } as unknown as WireExpenseLine;
}

export function toWireExpenseLines(lines: readonly ServerLine[], unit: string): WireExpenseLine[] {
  return lines.map((l) => toWireExpenseLine(l, unit));
}
