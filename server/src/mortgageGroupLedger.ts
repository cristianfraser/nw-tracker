import { resolveOperationalAccountId } from "./accountSource.js";
import {
  isDeptoMortgagePaymentCuota,
  mortgageMetaFromSheetRows,
} from "./deptoDividendosLedger.js";
import { loadDeptoLedgerFromMovements } from "./deptoLedgerFromMovements.js";
import { ensureMortgageLiabilityView, listLiabilitiesTabAccountRows } from "./liabilityTabAccounts.js";
import { buildDeptoPaymentScenarioRows } from "./mortgageScenarioPayments.js";

export type MortgageGroupLedgerResponse = {
  account_id: number;
  has_sheet_rows: boolean;
  meta: ReturnType<typeof mortgageMetaFromSheetRows> | null;
  rows: ReturnType<typeof loadDeptoLedgerFromMovements>;
  payment_scenarios?: ReturnType<typeof buildDeptoPaymentScenarioRows>;
};

function emptyMortgageGroupLedger(): MortgageGroupLedgerResponse {
  return {
    account_id: 0,
    has_sheet_rows: false,
    meta: null,
    rows: [],
    payment_scenarios: [],
  };
}

function mortgageLedgerForOperationalAccount(operationalId: number): MortgageGroupLedgerResponse {
  const sheetRowsAll = loadDeptoLedgerFromMovements();
  const sheetRows = sheetRowsAll.filter((r) => isDeptoMortgagePaymentCuota(r.cuota));
  return {
    account_id: operationalId,
    has_sheet_rows: sheetRowsAll.length > 0,
    meta: sheetRowsAll.length > 0 ? mortgageMetaFromSheetRows(sheetRowsAll) : null,
    rows: sheetRows,
    payment_scenarios: buildDeptoPaymentScenarioRows(sheetRowsAll),
  };
}

/** Aggregated mortgage ledger for liabilities portfolio groups. */
export function mortgageGroupLedgerResponse(portfolioGroupSlug: string): MortgageGroupLedgerResponse {
  if (portfolioGroupSlug !== "liabilities_mortgage" && portfolioGroupSlug !== "liabilities") {
    return emptyMortgageGroupLedger();
  }
  ensureMortgageLiabilityView();
  const mortgageRows = listLiabilitiesTabAccountRows("mortgage");
  if (mortgageRows.length === 0) {
    return emptyMortgageGroupLedger();
  }
  const operationalId = resolveOperationalAccountId(mortgageRows[0]!.account_id);
  return mortgageLedgerForOperationalAccount(operationalId);
}
