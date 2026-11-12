/**
 * The expense line as it goes over the wire: its money is `amount` (the currency it happened in)
 * and `values` (its value in each display unit, `lineMoney.ts`); the builders' peso and dollar
 * fields (`amount_clp`, `amount_usd`, `amount_usd_at_expense`, `clp_rate_source`) stay inside the
 * server. Every route that sends lines sends them through this. Typed structurally (no import of
 * the server line type) so the line builders can use it without an import cycle.
 */
import type { FlowCcExpenseLineRow as WireExpenseLine } from "nw-tracker-contracts/dto/flows";
import { lineAmount } from "./lineMoney.js";

type ServerLine = { amount_clp: number; amount_usd?: number | null; amount_usd_at_expense?: number | null; clp_rate_source?: unknown; amount?: { value: number; currency: string } };

export function toWireExpenseLine(l: ServerLine): WireExpenseLine {
  lineAmount(l); // throws on a line the «line money» step has not seen
  const { amount_clp: _c, amount_usd: _u, amount_usd_at_expense: _e, clp_rate_source: _r, ...wire } = l;
  return wire as unknown as WireExpenseLine;
}

export function toWireExpenseLines(lines: readonly ServerLine[]): WireExpenseLine[] {
  return lines.map(toWireExpenseLine);
}
