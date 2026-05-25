import { ymCompare, monthKeyFromYmd } from "./calendarMonth.js";
import { addCalendarMonths } from "./ccYearMonth.js";
import { listCreditCardMasterAccountIds } from "./creditCardTree.js";
import { chileCalendarTodayYmd } from "./chileDate.js";
import { assertCcStatementsHavePeriodTo } from "./ccStatementMetadata.js";
import { db } from "./db.js";
import {
  buildImportSyncDocumentMonths,
  buildImportSyncDocumentPathsByMonth,
  hasImportSyncDocumentForMonth,
} from "./importSyncDocumentFilePath.js";
import { cartolaCashAccountIdOptional } from "./movementBalanceCashAccounts.js";

export type ImportSyncDocumentKind =
  | "checking_cartola"
  | "cuenta_vista_cartola"
  | "cc_statement";

export type ImportSyncDocumentAccount = {
  account_id: number;
  label: string;
  document_kind: ImportSyncDocumentKind;
};

export type ImportSyncDocumentCell = {
  imported: boolean;
  file_path: string | null;
};

export type ImportSyncDocumentCoveragePayload = {
  months: string[];
  accounts: ImportSyncDocumentAccount[];
  cells: ImportSyncDocumentCell[][];
};

function accountLabel(accountId: number): string {
  const row = db.prepare(`SELECT name FROM accounts WHERE id = ?`).get(accountId) as
    | { name: string }
    | undefined;
  return row?.name?.trim() || `Account ${accountId}`;
}

function listDocumentAccounts(): ImportSyncDocumentAccount[] {
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
    accounts.push({
      account_id: accountId,
      label: accountLabel(accountId),
      document_kind: "cc_statement",
    });
  }
  return accounts;
}

function buildMonthRangeDesc(currentYm: string, earliestYm: string | null): string[] {
  if (!earliestYm || ymCompare(earliestYm, currentYm) > 0) {
    return [currentYm];
  }
  const out: string[] = [];
  let cur = currentYm;
  for (let guard = 0; guard < 600; guard += 1) {
    out.push(cur);
    if (cur === earliestYm) break;
    cur = addCalendarMonths(cur, -1);
  }
  return out;
}

export type BuildImportSyncDocumentCoverageOpts = {
  /** When true (default), 500 if any imported PDF row lacks `period_to`. */
  validateCcMetadata?: boolean;
};

export function buildImportSyncDocumentCoveragePayload(
  opts?: BuildImportSyncDocumentCoverageOpts
): ImportSyncDocumentCoveragePayload {
  if (opts?.validateCcMetadata !== false) {
    assertCcStatementsHavePeriodTo();
  }
  const accounts = listDocumentAccounts();
  const currentYm = monthKeyFromYmd(chileCalendarTodayYmd());

  let earliestYm: string | null = null;
  const byAccount = accounts.map((acc) => {
    const filePaths = buildImportSyncDocumentPathsByMonth(acc);
    const months = buildImportSyncDocumentMonths(acc);
    for (const ym of months) {
      if (earliestYm == null || ymCompare(ym, earliestYm) < 0) {
        earliestYm = ym;
      }
    }
    return { filePaths };
  });

  const monthList = buildMonthRangeDesc(currentYm, earliestYm);
  const cells = monthList.map((rowMonth) =>
    accounts.map((acc, accIdx) => {
      const imported = hasImportSyncDocumentForMonth(acc, rowMonth);
      const file_path = imported
        ? (byAccount[accIdx]?.filePaths.get(rowMonth) ?? null)
        : null;
      return { imported, file_path };
    })
  );

  return { months: monthList, accounts, cells };
}
