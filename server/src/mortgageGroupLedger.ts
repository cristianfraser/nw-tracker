import {
  isDeptoMortgagePaymentCuota,
  mortgageMetaFromSheetRows,
} from "./deptoDividendosLedger.js";
import { loadDeptoLedgerFromMovements } from "./deptoLedgerFromMovements.js";
import { listLiabilitiesTabAccountRows } from "./liabilityTabAccounts.js";
import { buildDeptoPaymentScenarioRows } from "./mortgageScenarioPayments.js";
import { mortgageCardMatches, type MortgageCardLine, type MortgagePaymentCardMatch } from "./mortgagePaymentCardMatch.js";

export type MortgageGroupLedgerResponse = {
  account_id: number;
  has_sheet_rows: boolean;
  meta: ReturnType<typeof mortgageMetaFromSheetRows> | null;
  rows: ReturnType<typeof loadDeptoLedgerFromMovements>;
  payment_scenarios?: ReturnType<typeof buildDeptoPaymentScenarioRows>;
  /** Each regular cuota paired with the card line that paid it (`mortgagePaymentCardMatch.ts`). */
  card_matches: MortgagePaymentCardMatch[];
  /** Mortgage card lines no cuota in the ledger claims (the sheet row is not posted yet). */
  card_lines_without_payment: MortgageCardLine[];
};

function emptyMortgageGroupLedger(): MortgageGroupLedgerResponse {
  return {
    account_id: 0,
    has_sheet_rows: false,
    meta: null,
    rows: [],
    payment_scenarios: [],
    card_matches: [],
    card_lines_without_payment: [],
  };
}

function mortgageLedgerForOperationalAccount(operationalId: number): MortgageGroupLedgerResponse {
  const sheetRowsAll = loadDeptoLedgerFromMovements();
  const sheetRows = sheetRowsAll.filter((r) => isDeptoMortgagePaymentCuota(r.cuota));
  const matches = mortgageCardMatches();
  return {
    account_id: operationalId,
    has_sheet_rows: sheetRowsAll.length > 0,
    meta: sheetRowsAll.length > 0 ? mortgageMetaFromSheetRows(sheetRowsAll) : null,
    rows: sheetRows,
    payment_scenarios: buildDeptoPaymentScenarioRows(sheetRowsAll),
    card_matches: matches.payments,
    card_lines_without_payment: matches.unmatched_lines,
  };
}

/** Aggregated mortgage ledger for liabilities portfolio groups. */
export function mortgageGroupLedgerResponse(portfolioGroupSlug: string): MortgageGroupLedgerResponse {
  if (portfolioGroupSlug !== "liabilities_mortgage" && portfolioGroupSlug !== "liabilities") {
    return emptyMortgageGroupLedger();
  }
  const mortgageRows = listLiabilitiesTabAccountRows("mortgage");
  if (mortgageRows.length === 0) {
    return emptyMortgageGroupLedger();
  }
  return mortgageLedgerForOperationalAccount(mortgageRows[0]!.account_id);
}
