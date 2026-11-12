import type { FlowCcExpenseLineRow } from "../types";

/** A peso line's money as the server sends it (requested in pesos). */
export function clpMoney(value: number): Pick<FlowCcExpenseLineRow, "amount" | "converted" | "value_clp"> {
  return { amount: { value, currency: "clp" }, converted: { value, currency: "clp", rate_source: "native" }, value_clp: value };
}
