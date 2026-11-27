/** The import-sync coverage matrix's columns: one per cartola account, one or two per card. */
import { listCreditCardMasterAccountIds } from "./creditCardTree.js";
import { db } from "./db.js";
import { ccCreditCardAccountHasUsdStatements } from "./importSyncDocumentFilePath.js";
import { cartolaCashAccountIdOptional } from "./movementBalanceCashAccounts.js";
import type { ImportSyncDocumentAccount } from "./importSyncDocumentTypes.js";

function accountLabel(accountId: number): string {
  const row = db.prepare(`SELECT name FROM accounts WHERE id = ?`).get(accountId) as
    | { name: string }
    | undefined;
  return row?.name?.trim() || `Account ${accountId}`;
}

/**
 * The checking and cuenta vista cartola columns, then each card master: a card with a USD
 * statement has a CLP and a USD column (`cc_statement_currency`), any other card one column.
 */
export function listImportSyncDocumentAccounts(): ImportSyncDocumentAccount[] {
  const accounts: ImportSyncDocumentAccount[] = [];
  const checkingId = cartolaCashAccountIdOptional("cuenta_corriente");
  if (checkingId != null) {
    accounts.push({
      account_id: checkingId,
      label: accountLabel(checkingId),
      document_kind: "checking_cartola",
    });
  }
  const vistaId = cartolaCashAccountIdOptional("cuenta_vista");
  if (vistaId != null) {
    accounts.push({
      account_id: vistaId,
      label: accountLabel(vistaId),
      document_kind: "cuenta_vista_cartola",
    });
  }
  for (const accountId of listCreditCardMasterAccountIds()) {
    const label = accountLabel(accountId);
    if (ccCreditCardAccountHasUsdStatements(accountId)) {
      accounts.push({
        account_id: accountId,
        label,
        document_kind: "cc_statement",
        cc_statement_currency: "clp",
      });
      accounts.push({
        account_id: accountId,
        label,
        document_kind: "cc_statement",
        cc_statement_currency: "usd",
      });
    } else {
      accounts.push({
        account_id: accountId,
        label,
        document_kind: "cc_statement",
      });
    }
  }
  return accounts;
}
