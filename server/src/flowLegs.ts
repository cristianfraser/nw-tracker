/**
 * A flow's value in a display unit from the legs its builder already computed: its pesos (`clp`,
 * always set) and its dollars (`usd`: the event's own dollars, or its pesos at the buy rate on or
 * before the day; null when no rate was on file). A builder that only needs one unit may pass the
 * dollar leg as a function, read only when the unit is USD. Any other unit converts the event's
 * own leg (`native`: the pesos unless the event moved dollars) at the day's mid through
 * `rates.ts` — never dollars through pesos. Null when no rate is on file for the day. Readers pick
 * a leg here instead of branching on the unit themselves.
 */
import { convertCurrency, type CurrencyCode } from "./rates.js";

export type FlowLegs = {
  clp: number;
  usd: number | null | (() => number | null);
  /** The currency the event moved (its own leg); the pesos by default. */
  native?: CurrencyCode;
  /**
   * The event's own amount in `native` when that is neither pesos nor dollars (a euro credit): the
   * unit `native` reads it as is, any other unit converts it.
   */
  native_amount?: number;
};

function usdLeg(legs: FlowLegs): number | null {
  return typeof legs.usd === "function" ? legs.usd() : legs.usd;
}

export function flowLegsInUnit(legs: FlowLegs, ymd: string, unit: CurrencyCode): number | null {
  if (unit === "clp") return legs.clp;
  if (unit === "usd") return usdLeg(legs);
  if (legs.native_amount != null && legs.native != null) {
    if (legs.native === unit) return legs.native_amount;
    if (legs.native_amount === 0) return 0;
    return convertCurrency(legs.native_amount, legs.native, unit, ymd, { side: "mid" });
  }
  if (legs.native === "usd") {
    const usd = usdLeg(legs);
    if (usd == null) return null;
    if (usd === 0) return 0;
    return convertCurrency(usd, "usd", unit, ymd, { side: "mid" });
  }
  if (legs.clp === 0) return 0;
  return convertCurrency(legs.clp, "clp", unit, ymd, { side: "mid" });
}

/** {@link flowLegsInUnit} that throws when no rate is on file (a flow is never dropped from a total). */
export function requireFlowLegsInUnit(legs: FlowLegs, ymd: string, unit: CurrencyCode, what: string): number {
  const v = flowLegsInUnit(legs, ymd, unit);
  if (v == null || !Number.isFinite(v)) throw new Error(`${what} ${ymd}: no ${unit} value (no rate on file)`);
  return v;
}
