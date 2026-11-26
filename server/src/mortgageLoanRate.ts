import type { DeptoMortgageSheetRow as MortgageLedgerRowDto } from "nw-tracker-contracts/dto";
import { isDeptoPieCuota, isDeptoPrepagoCuota } from "./deptoDividendosLedger.js";

/**
 * A loan's own monthly rate, read from its ledger (pie first): the interest of its last regular
 * cuota over the balance its bank sequence left before it, a prepago in between included — the
 * lender recomputes the cuota on the balance after a prepago, so that ratio is the same monthly
 * rate as the cuotas either side, not the rate on the balance before the prepago. Null while the
 * loan has no regular cuota.
 */
export function loanMonthlyRate(ledger: readonly MortgageLedgerRowDto[]): number | null {
  if (!ledger[0] || !isDeptoPieCuota(ledger[0].cuota)) throw new Error("loan rate: the ledger does not open with the pie");
  let last = -1;
  for (let i = 1; i < ledger.length; i++) if (!isDeptoPrepagoCuota(ledger[i]!.cuota)) last = i;
  if (last < 0) return null;
  const cuota = ledger[last]!;
  const before = ledger[last - 1]!.credito_restante_loan;
  if (before == null || !Number.isFinite(before) || !(before > 0)) {
    throw new Error(`loan rate: no balance before cuota ${cuota.cuota}`);
  }
  if (cuota.interes_loan == null || !Number.isFinite(cuota.interes_loan)) {
    throw new Error(`loan rate: cuota ${cuota.cuota} states no interest`);
  }
  return cuota.interes_loan / before;
}
