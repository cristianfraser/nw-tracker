/**
 * An expense line's money: `amount` in the currency it happened in, and `values` — its value in
 * each display unit, with how it was reached (`LineRateSource`). The one place a reader asks for a
 * line's value in a unit (`lineValueIn`) or for its native amount (`lineAmount`).
 *
 * The conversions are the ones the line builders already apply: a card's dollar line in pesos at
 * the rate its facturación was paid (`facturacionUsdRateWithSourceResolver`: paid / live / pay_by),
 * a dollar payment line at the pesos paid for it (`usdPaymentLineClpResolver`: paid), anything else
 * at the day's rate (`expenseGastosAmountUsdAtDate`: day). The «line money» step records them from
 * the builders' fields, so `values.clp` is the line's pesos and `values.usd` its dollars as every
 * reader saw them before.
 */
import type { LineRateSource, LineUnitValue, Money } from "nw-tracker-contracts/dto/flows";

type MoneyFields = {
  amount_clp: number;
  amount_usd?: number | null;
  amount_usd_at_expense?: number | null;
  clp_rate_source?: LineRateSource;
  amount?: Money;
  values?: Record<string, LineUnitValue>;
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

/** The line's value in a display unit; null when it has none (no rate for its day). */
export function lineValueIn(l: Pick<MoneyFields, "values">, unit: string): number | null {
  if (!l.values) throw new Error("expense line without its money (the «line money» step has not run)");
  return l.values[unit]?.value ?? null;
}
