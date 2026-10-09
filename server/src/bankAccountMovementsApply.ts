import type { BankAccountMovementsApplyDetails, BankAccountMovementsPayload } from "nw-tracker-contracts";
import { db } from "./db.js";
import { checkingAccountId } from "./checkingCartolaImport.js";
import { importCheckingPartialMovements } from "./checkingPartialMovementsImport.js";
import { createImportBatch } from "./importBatches.js";

/** The ledger account an ingested bank-account listing names. Only Santander checking is mapped. */
export function accountIdForIssuerBankAccount(account: BankAccountMovementsPayload["account"]): number {
  if (account.issuer === "santander" && account.product === "checking") return checkingAccountId();
  throw new Error(`No ledger account for the ${account.issuer} ${account.product} account`);
}

const bareNumber = (n: string) => n.replace(/^0+/, "");

/**
 * A listing that names its account number must be the mapped account's (2026-10-09): the bank's
 * dollar cuenta corriente downloads under the same filename as the peso one, and its rows would
 * otherwise land in the peso ledger. Checked against `bank_account_numbers` (issuer + the peso
 * currency, leading zeros ignored): a number declared for another account, or a declared number
 * for this account that differs, is a hard error. An account with no declared number (demo, a
 * fresh install) has nothing to check against and is accepted.
 */
export function assertListingNamesAccount(accountId: number, account: BankAccountMovementsPayload["account"]): void {
  if (account.number === undefined) return;
  const rows = db
    .prepare(`SELECT account_id, number FROM bank_account_numbers WHERE issuer = ? AND currency = 'clp'`)
    .all(account.issuer) as { account_id: number; number: string }[];
  const own = rows.find((r) => r.account_id === accountId);
  const named = rows.filter((r) => bareNumber(r.number) === bareNumber(account.number!));
  if (own && bareNumber(own.number) !== bareNumber(account.number)) {
    throw new Error(
      `bank_account.movements names ${account.issuer} ${account.product} account number ending …${account.number.slice(-4)}, ` +
        `which is not the number declared for ledger account ${accountId} (…${own.number.slice(-4)}) — refused`
    );
  }
  const other = named.find((r) => r.account_id !== accountId);
  if (other) {
    throw new Error(
      `bank_account.movements names ${account.issuer} account number ending …${account.number.slice(-4)}, ` +
        `which is declared for ledger account ${other.account_id}, not the ${account.product} account ${accountId} — refused`
    );
  }
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
  assertListingNamesAccount(accountId, payload.account);
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
