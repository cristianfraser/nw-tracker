/**
 * An expense line's money: `amount` in the currency it happened in, and its value in a display
 * unit with how it was reached (`LineRateSource`). The one place a reader asks for a line's value
 * in a unit (`lineValueIn` / `lineConvertedIn`) or for its native amount (`lineAmount`).
 *
 * The builders reach pesos and dollars (`values.clp`, `values.usd`): a card's dollar line in pesos
 * at the rate its facturación was paid (`facturacionUsdRateWithSourceResolver`: paid / live /
 * pay_by), a dollar payment line at the pesos paid for it (`usdPaymentLineClpResolver`: paid),
 * anything else at the day's rate (`expenseGastosAmountUsdAtDate`: day). The «line money» step
 * records them from the builders' fields, so `values.clp` is the line's pesos and `values.usd` its
 * dollars as every reader saw them before.
 *
 * Any other unit (EUR, …) is derived when asked, through `rates.ts` at the line's day mid: a line
 * whose pesos came from a paid / live / pay-by rate converts THOSE pesos (rate source kept), any
 * other line its own amount (rate source `day`, or `native` when it is in the unit).
 */
import type { LineConverted, LineRateSource, LineUnitValue, Money } from "nw-tracker-contracts/dto/flows";
import { convertCurrency } from "./rates.js";

type MoneyFields = {
  amount_clp: number;
  amount_usd?: number | null;
  amount_usd_at_expense?: number | null;
  clp_rate_source?: LineRateSource;
  amount?: Money;
  values?: Record<string, LineUnitValue>;
  occurred_on?: string;
  purchase_on?: string | null;
};

/** The line's money derived from the builders' fields (pure). */
export function lineMoneyFromBuilderFields(l: MoneyFields): { amount: Money; values: Record<string, LineUnitValue> } {
  const nativeUsd = l.amount_usd != null && Number.isFinite(l.amount_usd) && l.amount_usd !== 0 ? l.amount_usd : null;
  const amount: Money = nativeUsd != null ? { value: nativeUsd, currency: "usd" } : { value: l.amount_clp, currency: "clp" };
  const values: Record<string, LineUnitValue> = {
    clp: { value: l.amount_clp, rate_source: nativeUsd != null ? (l.clp_rate_source ?? "day") : "native" },
  };
  if (l.amount_usd_at_expense != null) {
    values.usd = { value: l.amount_usd_at_expense, rate_source: nativeUsd != null ? "native" : "day" };
  }
  return { amount, values };
}

/** The «line money» step: every line gets its `amount` and `values`. */
export function withLineMoney<L extends MoneyFields>(lines: readonly L[]): L[] {
  return lines.map((l) => {
    const { clp_rate_source: _hint, ...rest } = l;
    return { ...rest, ...lineMoneyFromBuilderFields(l) } as L;
  });
}

/** The line in its own currency. Throws on a line the «line money» step has not seen. */
export function lineAmount(l: Pick<MoneyFields, "amount">): Money {
  if (!l.amount) throw new Error("expense line without its money (the «line money» step has not run)");
  return l.amount;
}

/** What a value lookup reads (the rest of a line is never needed). */
type LookupFields = Pick<MoneyFields, "amount" | "values" | "occurred_on" | "purchase_on">;

/** Rate sources that put a card dollar line's pesos at a facturación's own rate, not the day's. */
const FACTURACION_RATE_SOURCES: ReadonlySet<LineRateSource> = new Set(["paid", "live", "pay_by"]);

const derived = new WeakMap<object, Map<string, LineUnitValue | null>>();

/**
 * A line's value in a unit the builders did not reach (pure in the line and the stored rates): its
 * pesos when they came from a facturación's rate, else its own amount, at the line's day mid.
 */
function derivedUnitValue(l: LookupFields, unit: string): LineUnitValue | null {
  const amount = lineAmount(l);
  if (amount.currency === unit) return { value: amount.value, rate_source: "native" };
  const day = l.purchase_on ?? l.occurred_on;
  if (!day) throw new Error(`expense line without a day: cannot convert it to ${unit}`);
  const clp = l.values!.clp!;
  if (FACTURACION_RATE_SOURCES.has(clp.rate_source)) {
    const v = convertCurrency(clp.value, "clp", unit, day, { side: "mid" });
    return v == null ? null : { value: v, rate_source: clp.rate_source };
  }
  const v = convertCurrency(amount.value, amount.currency, unit, day, { side: "mid" });
  return v == null ? null : { value: v, rate_source: "day" };
}

/** The line's value in a display unit with how it was reached; null when it has none (no rate for its day). */
export function lineConvertedIn(l: LookupFields, unit: string): LineUnitValue | null {
  if (!l.values) throw new Error("expense line without its money (the «line money» step has not run)");
  const own = l.values[unit];
  if (own) return own;
  if (unit === "clp" || unit === "usd") return null;
  let memo = derived.get(l);
  if (!memo) derived.set(l, (memo = new Map()));
  if (!memo.has(unit)) memo.set(unit, derivedUnitValue(l, unit));
  return memo.get(unit)!;
}

/** The line's value in a display unit; null when it has none (no rate for its day). */
export function lineValueIn(l: LookupFields, unit: string): number | null {
  return lineConvertedIn(l, unit)?.value ?? null;
}

/** The wire form of a line's value in the requested unit (`converted`). */
export function lineConvertedForWire(l: LookupFields, unit: string): LineConverted | null {
  const v = lineConvertedIn(l, unit);
  return v == null ? null : { value: v.value, currency: unit, rate_source: v.rate_source };
}

/** The line's pesos (always set: the builders work in pesos). */
export function linePesos(l: LookupFields): number {
  const v = lineValueIn(l, "clp");
  if (v == null) throw new Error("expense line without its pesos");
  return v;
}
