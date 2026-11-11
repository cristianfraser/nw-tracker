import type { FlowCcExpenseLineRow } from "../types";

/** A peso line's money as the server sends it. */
export function clpMoney(value: number): Pick<FlowCcExpenseLineRow, "amount" | "values"> {
  return { amount: { value, currency: "clp" }, values: { clp: { value, rate_source: "native" } } };
}
