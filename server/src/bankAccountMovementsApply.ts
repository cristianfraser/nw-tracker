import type {
  BankAccountMovementsApplyDetails,
  BankAccountMovementsPayload,
  UsdAccountMovementsApplyDetails,
} from "nw-tracker-contracts";
import { db } from "./db.js";
import { checkingAccountId } from "./checkingCartolaImport.js";
import { importCheckingPartialMovements } from "./checkingPartialMovementsImport.js";
import { createImportBatch } from "./importBatches.js";
import { confirmUsdAccountMovements } from "./usdAccountMovementsConfirm.js";

const bareNumber = (n: string) => n.replace(/^0+/, "");

type DeclaredNumber = { account_id: number; number: string };

function declaredNumbers(issuer: string, currency: "clp" | "usd"): DeclaredNumber[] {
  return db
    .prepare(`SELECT account_id, number FROM bank_account_numbers WHERE issuer = ? AND currency = ?`)
    .all(issuer, currency) as DeclaredNumber[];
}

/**
 * The ledger account an ingested bank-account listing names. A peso checking listing is the
 * cuenta corriente; a dollar one is the account `bank_account_numbers` declares for the number
 * the listing names (2026-10-10) — the dollar account has no other identity, so a dollar listing
 * without a number, or with a number no account declares, is refused.
 */
export function accountIdForIssuerBankAccount(account: BankAccountMovementsPayload["account"]): number {
  if (account.product !== "checking") throw new Error(`No ledger account for the ${account.issuer} ${account.product} account`);
  if (account.currency === "clp") {
    if (account.issuer === "santander") return checkingAccountId();
    throw new Error(`No ledger account for the ${account.issuer} ${account.product} account`);
  }
  if (account.number === undefined) {
    throw new Error(`A dollar ${account.issuer} ${account.product} listing must name its account number — refused`);
  }
  const named = declaredNumbers(account.issuer, "usd").filter((r) => bareNumber(r.number) === bareNumber(account.number!));
  if (named.length === 0) {
    throw new Error(
      `No ledger account declares the ${account.issuer} dollar account number ending …${account.number.slice(-4)} (bank_account_numbers) — refused`
    );
  }
  if (named.length > 1) {
    throw new Error(`Two ledger accounts declare the ${account.issuer} dollar account number ending …${account.number.slice(-4)} — refused`);
  }
  return named[0]!.account_id;
}

/**
 * A listing that names its account number must be the mapped account's (2026-10-09): the bank's
 * dollar cuenta corriente downloads under the same filename as the peso one, and its rows would
 * otherwise land in the peso ledger. Checked against `bank_account_numbers` (issuer + the
 * listing's currency, leading zeros ignored): a number declared for another account, or a
 * declared number for this account that differs, is a hard error. An account with no declared
 * number (demo, a fresh install) has nothing to check against and is accepted.
 */
export function assertListingNamesAccount(accountId: number, account: BankAccountMovementsPayload["account"]): void {
  if (account.number === undefined) return;
  const rows = declaredNumbers(account.issuer, account.currency);
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
 * Apply a `bank_account.movements` listing. A PESO account's rows the ledger does not hold yet
 * (not a repeat, not covered by the month's cartola, not a transfer leg the ledger already has)
 * are inserted (`importCheckingPartialMovements`), and the import is logged as a
 * `checking_recent_xlsx` batch under `sourceRef` with the rows the feeder could not read — as the
 * xlsx import always did. A DOLLAR account's rows are confirmed against the ledger and never
 * inserted (`confirmUsdAccountMovements`).
 */
export function applyBankAccountMovements(
  payload: BankAccountMovementsPayload,
  sourceRef: string
): BankAccountMovementsApplyDetails | UsdAccountMovementsApplyDetails {
  const accountId = accountIdForIssuerBankAccount(payload.account);
  assertListingNamesAccount(accountId, payload.account);
  if (payload.account.currency === "usd") {
    if (payload.rejected_rows.length > 0) {
      throw new Error(`a dollar listing with rows the feeder could not read: ${payload.rejected_rows.join("; ")}`);
    }
    return confirmUsdAccountMovements(accountId, payload.movements, sourceRef);
  }
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
