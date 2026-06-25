import { countsTowardAbonosMes } from "../../ccExpenseLineBuckets";
import { isCcStatementFinancingCostLine } from "../../ccStatementSection3";
import type { FlowCcExpenseLineRow } from "../../types";
import { sortCreditCardExpenseLinesByStatement } from "./CreditCardExpenseLinesTable";

export type FacturacionModalBucket = {
  gastos: FlowCcExpenseLineRow[];
  costeFinanciero: FlowCcExpenseLineRow[];
  abonos: FlowCcExpenseLineRow[];
};

export function emptyFacturacionModalBucket(): FacturacionModalBucket {
  return { gastos: [], costeFinanciero: [], abonos: [] };
}

/** Statement lines split into gastos, financing charges, and payments/credits (abonos). */
export function buildFacturacionModalBucket(
  lines: readonly FlowCcExpenseLineRow[]
): FacturacionModalBucket {
  const abonos = lines
    .filter(countsTowardAbonosMes)
    .sort(sortCreditCardExpenseLinesByStatement);
  const charges = lines.filter((ln) => !countsTowardAbonosMes(ln));
  const costeFinanciero = charges
    .filter(isCcStatementFinancingCostLine)
    .sort(sortCreditCardExpenseLinesByStatement);
  const gastos = charges
    .filter((ln) => !isCcStatementFinancingCostLine(ln))
    .sort(sortCreditCardExpenseLinesByStatement);
  return { gastos, costeFinanciero, abonos };
}

export function isFacturacionModalBucketEmpty(bucket: FacturacionModalBucket): boolean {
  return (
    bucket.gastos.length === 0 &&
    bucket.costeFinanciero.length === 0 &&
    bucket.abonos.length === 0
  );
}
