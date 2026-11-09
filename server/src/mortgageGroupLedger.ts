import {
  isDeptoMortgagePaymentCuota,
  mortgageMetaFromSheetRows,
} from "./deptoDividendosLedger.js";
import { deptoLedgerForLoan } from "./deptoLedgerFromMovements.js";
import type { DeptoMortgageSheetRow } from "./deptoDividendosLedger.js";
import { listLiabilitiesTabAccountRows } from "./liabilityTabAccounts.js";
import { buildDeptoPaymentScenarioRows } from "./mortgageScenarioPayments.js";
import { mortgageCardMatches, type MortgageCardLine, type MortgagePaymentCardMatch } from "./mortgagePaymentCardMatch.js";

export type MortgageGroupLedgerResponse = {
  account_id: number;
  has_sheet_rows: boolean;
  meta: ReturnType<typeof mortgageMetaFromSheetRows> | null;
  rows: DeptoMortgageSheetRow[];
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
  const sheetRowsAll = deptoLedgerForLoan(operationalId);
  const sheetRows = sheetRowsAll.filter((r) => isDeptoMortgagePaymentCuota(r.cuota));
  const matches = mortgageCardMatches(operationalId);
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

/**
 * One loan's mortgage ledger on a liabilities portfolio group page: `loanAccountId` (a mortgage
 * account of the group), or the group's one mortgage when omitted. Empty when the group holds no
 * mortgage or the asked account is not one of its mortgages; several mortgages and none asked for
 * throws (the page asks per loan).
 */
export function mortgageGroupLedgerResponse(
  portfolioGroupSlug: string,
  loanAccountId?: number
): MortgageGroupLedgerResponse {
  if (portfolioGroupSlug !== "liabilities_mortgage" && portfolioGroupSlug !== "liabilities") {
    return emptyMortgageGroupLedger();
  }
  const mortgageIds = listLiabilitiesTabAccountRows("mortgage").map((r) => r.account_id);
  if (loanAccountId != null) {
    return mortgageIds.includes(loanAccountId)
      ? mortgageLedgerForOperationalAccount(loanAccountId)
      : emptyMortgageGroupLedger();
  }
  if (mortgageIds.length === 0) return emptyMortgageGroupLedger();
  if (mortgageIds.length > 1) {
    throw new Error(
      `mortgage ledger of ${portfolioGroupSlug}: ${mortgageIds.length} mortgages (${mortgageIds.join(", ")}) — ask for one (account_id)`
    );
  }
  return mortgageLedgerForOperationalAccount(mortgageIds[0]!);
}
