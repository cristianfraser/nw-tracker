import { countsTowardAbonosMes } from "../../ccExpenseLineBuckets";
import type { FlowCcExpenseLineRow } from "../../types";
import { sortCreditCardExpenseLinesByStatement } from "./CreditCardExpenseLinesTable";

export type FacturacionModalBucket = {
  gastos: FlowCcExpenseLineRow[];
  abonos: FlowCcExpenseLineRow[];
};

export function emptyFacturacionModalBucket(): FacturacionModalBucket {
  return { gastos: [], abonos: [] };
}

/** Statement lines split into charges (gastos) vs payments/credits (abonos). */
export function buildFacturacionModalBucket(
  lines: readonly FlowCcExpenseLineRow[]
): FacturacionModalBucket {
  const abonos = lines
    .filter(countsTowardAbonosMes)
    .sort(sortCreditCardExpenseLinesByStatement);
  const gastos = lines
    .filter((ln) => !countsTowardAbonosMes(ln))
    .sort(sortCreditCardExpenseLinesByStatement);
  return { gastos, abonos };
}

export function isFacturacionModalBucketEmpty(bucket: FacturacionModalBucket): boolean {
  return bucket.gastos.length === 0 && bucket.abonos.length === 0;
}
