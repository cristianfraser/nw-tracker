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

/**
 * Statement lines split into gastos, financing charges, and payments/credits (abonos). Which
 * lines are abonos (`abono`) and which charges are financing is the server's call (`is_financing_cost`, the statement-line rules the
 * card's P/L reads).
 */
export function buildFacturacionModalBucket(
  lines: readonly FlowCcExpenseLineRow[]
): FacturacionModalBucket {
  const abonos = lines.filter((ln) => ln.abono === true).sort(sortCreditCardExpenseLinesByStatement);
  const charges = lines.filter((ln) => ln.abono !== true);
  const costeFinanciero = charges
    .filter((ln) => ln.is_financing_cost === true)
    .sort(sortCreditCardExpenseLinesByStatement);
  const gastos = charges
    .filter((ln) => ln.is_financing_cost !== true)
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
