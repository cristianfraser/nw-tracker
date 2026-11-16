import { isDeptoMortgagePaymentCuota } from "./deptoDividendosLedger.js";
import { deptoLedgerForLoan } from "./deptoLedgerFromMovements.js";
import { listLiabilitiesTabAccountRows } from "./liabilityTabAccounts.js";
import { emptyMortgageLedgerDto, mortgageLedgerDto, type AccountMortgageLedgerResponse } from "./mortgageLedgerDto.js";

/** `GET /api/portfolio-groups/:slug/mortgage-ledger`: the shared ledger payload (`mortgageLedgerDto.ts`). */
export type MortgageGroupLedgerResponse = AccountMortgageLedgerResponse;

function emptyMortgageGroupLedger(): MortgageGroupLedgerResponse {
  return { ...emptyMortgageLedgerDto(0), payment_scenarios: [] };
}

function mortgageLedgerForOperationalAccount(operationalId: number): MortgageGroupLedgerResponse {
  const sheetRowsAll = deptoLedgerForLoan(operationalId);
  return mortgageLedgerDto({
    accountId: operationalId,
    ledger: sheetRowsAll,
    rows: sheetRowsAll.filter((r) => isDeptoMortgagePaymentCuota(r.cuota)),
    loanAccountId: operationalId,
  });
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
