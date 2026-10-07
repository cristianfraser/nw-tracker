import type { BankAccountMovementsApplyDetails, BankAccountMovementsPayload } from "nw-tracker-contracts";
import { checkingAccountId } from "./checkingCartolaImport.js";
import { importCheckingPartialMovements } from "./checkingPartialMovementsImport.js";
import { createImportBatch } from "./importBatches.js";

/** The ledger account an ingested bank-account listing names. Only Santander checking is mapped. */
export function accountIdForIssuerBankAccount(account: BankAccountMovementsPayload["account"]): number {
  if (account.issuer === "santander" && account.product === "checking") return checkingAccountId();
  throw new Error(`No ledger account for the ${account.issuer} ${account.product} account`);
}

/**
 * Apply a `bank_account.movements` listing: each row the ledger does not hold yet (not a repeat,
 * not covered by the month's cartola, not a transfer leg the ledger already has) is inserted
 * (`importCheckingPartialMovements`), and the import is logged as a `checking_recent_xlsx` batch
 * under `sourceRef` with the rows the feeder could not read — as the xlsx import always did.
 */
export function applyBankAccountMovements(
  payload: BankAccountMovementsPayload,
  sourceRef: string
): BankAccountMovementsApplyDetails {
  const accountId = accountIdForIssuerBankAccount(payload.account);
  const result = importCheckingPartialMovements(
    accountId,
    payload.movements.map((m) => ({
      occurred_on: m.date,
      description: m.description,
      amount_clp: m.amount,
      document_no: m.document_no ?? "",
    }))
  );
  const batch_id = createImportBatch("checking_recent_xlsx", sourceRef, {
    format: "ultimos_movimientos",
    inserted: result.inserted,
    skipped_duplicate: result.skipped_duplicate,
    skipped_superseded_by_cartola: result.skipped_superseded_by_cartola,
    skipped_superseded_by_transfer: result.skipped_superseded_by_transfer,
    skipped_superseded_by_mail: result.skipped_superseded_by_mail,
    errors: payload.rejected_rows,
  });
  return { account_id: accountId, batch_id, ...result };
}
