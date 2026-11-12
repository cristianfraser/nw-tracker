/**
 * A flow's value in a display unit from the legs its builder already computed: its pesos (`clp`,
 * always set) and its dollars (`usd`: the event's own dollars, or its pesos at the buy rate on or
 * before the day; null when no rate was on file). Any other unit converts the pesos at the day's
 * mid through `rates.ts` — the flows rule (`flowEventInUnit`: the CLP leg for any unit but USD).
 * Null when no rate is on file for the day. Readers pick a leg here instead of branching on the
 * unit themselves.
 */
import { convertCurrency } from "./rates.js";

export function flowLegsInUnit(legs: { clp: number; usd: number | null }, ymd: string, unit: string): number | null {
  if (unit === "clp") return legs.clp;
  if (unit === "usd") return legs.usd;
  if (legs.clp === 0) return 0;
  return convertCurrency(legs.clp, "clp", unit, ymd, { side: "mid" });
}

/** {@link flowLegsInUnit} that throws when no rate is on file (a flow is never dropped from a total). */
export function requireFlowLegsInUnit(legs: { clp: number; usd: number | null }, ymd: string, unit: string, what: string): number {
  const v = flowLegsInUnit(legs, ymd, unit);
  if (v == null || !Number.isFinite(v)) throw new Error(`${what} ${ymd}: no ${unit} value (no rate on file)`);
  return v;
}
