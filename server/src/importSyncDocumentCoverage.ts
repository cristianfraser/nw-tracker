import { ymCompare, monthKeyFromYmd } from "./calendarMonth.js";
import { listCreditCardMasterAccountIds } from "./creditCardTree.js";
import { chileCalendarTodayYmd } from "./chileDate.js";
import { assertCcStatementsHavePeriodTo } from "./ccStatementMetadata.js";
import { db } from "./db.js";
import {
  assertAllCcStatementPdfsResolvable,
  buildImportSyncDocumentMonths,
  buildImportSyncDocumentPathsByMonth,
  ccCreditCardAccountHasUsdStatements,
  hasImportSyncDocumentForMonth,
} from "./importSyncDocumentFilePath.js";
import { importSyncCartolaSinMovimientosForMonth } from "./importSyncCartolaSinMovimientos.js";
import { cartolaCashAccountIdOptional } from "./movementBalanceCashAccounts.js";
import { addCalendarMonths } from "nw-tracker-contracts";

import type { ImportSyncDocumentAccount } from "./importSyncDocumentTypes.js";

export type {
  CcStatementCoverageCurrency,
  ImportSyncDocumentAccount,
  ImportSyncDocumentKind,
} from "./importSyncDocumentTypes.js";

/**
 * What a month's cell shows, decided here so the page only picks a mark: a month before the
 * column's first document is `before_first` (drawn empty, counted nowhere), and the month in
 * progress with no document yet is `not_due` (its cartola or statement cannot exist before the
 * month ends or the card closes), counted nowhere either.
 */
export type ImportSyncDocumentCellState =
  | "imported"
  | "imported_no_file"
  | "no_movements"
  | "file_not_imported"
  | "missing"
  | "not_due"
  | "before_first";

export type ImportSyncDocumentCell = {
  imported: boolean;
  file_path: string | null;
  /** Cartola for this month has no imported movements (○ marker). */
  file_sin_movimientos?: boolean;
  state: ImportSyncDocumentCellState;
};

/** One column's months of a year: those from its first document on, and how many are imported. */
export type ImportSyncDocumentYearColumn = { counted: number; imported: number };

export type ImportSyncDocumentYear = {
  year: number;
  /** Indexes into `months` / `cells` of this year's months, newest first. */
  month_indexes: number[];
  /** Per column of `accounts`; null = the column has no document by this year. */
  columns: (ImportSyncDocumentYearColumn | null)[];
  /** Columns with a counted month this year, and those with every counted month imported. */
  columns_counted: number;
  columns_complete: number;
  /** The columns short of a month this year, in column order (the year's line names them). */
  incomplete_columns: number[];
};

export type ImportSyncDocumentCoveragePayload = {
  months: string[];
  accounts: ImportSyncDocumentAccount[];
  cells: ImportSyncDocumentCell[][];
  /** The matrix by year, newest first (the page shows a line per year). */
  years: ImportSyncDocumentYear[];
};

function cellState(c: { imported: boolean; file_path: string | null; file_sin_movimientos: boolean }): Exclude<ImportSyncDocumentCellState, "before_first" | "not_due"> {
  if (c.file_sin_movimientos) return "no_movements";
  if (c.imported) return c.file_path ? "imported" : "imported_no_file";
  return c.file_path ? "file_not_imported" : "missing";
}

/**
 * Marks the months before each column's first document and the month in progress (`currentYm`)
 * while it has no document, and adds the rest up by year.
 */
export function buildImportSyncDocumentYears(
  months: string[],
  columnCount: number,
  rawCells: { imported: boolean; file_path: string | null; file_sin_movimientos: boolean }[][],
  currentYm: string
): { cells: ImportSyncDocumentCell[][]; years: ImportSyncDocumentYear[] } {
  // `months` is newest first: a column's first document is its LAST row holding one.
  const firstRow = Array.from({ length: columnCount }, (_, col) => {
    for (let row = months.length - 1; row >= 0; row -= 1) {
      const c = rawCells[row]![col]!;
      if (c.imported || c.file_path) return row;
    }
    return -1;
  });
  const cells = rawCells.map((row, rowIdx) =>
    row.map((c, col): ImportSyncDocumentCell => {
      if (rowIdx > firstRow[col]!) return { ...c, state: "before_first" };
      const state = cellState(c);
      return { ...c, state: state === "missing" && months[rowIdx] === currentYm ? "not_due" : state };
    })
  );
  const years: ImportSyncDocumentYear[] = [];
  months.forEach((ym, rowIdx) => {
    const year = Number(ym.slice(0, 4));
    let entry = years[years.length - 1];
    if (!entry || entry.year !== year) {
      entry = { year, month_indexes: [], columns: Array.from({ length: columnCount }, () => null), columns_counted: 0, columns_complete: 0, incomplete_columns: [] };
      years.push(entry);
    }
    entry.month_indexes.push(rowIdx);
    cells[rowIdx]!.forEach((c, col) => {
      if (c.state === "before_first" || c.state === "not_due") return;
      const column = (entry.columns[col] ??= { counted: 0, imported: 0 });
      column.counted += 1;
      if (c.imported) column.imported += 1;
    });
  });
  for (const y of years) {
    const counted = y.columns.filter((c): c is ImportSyncDocumentYearColumn => c != null);
    y.columns_counted = counted.length;
    y.columns_complete = counted.filter((c) => c.imported === c.counted).length;
    y.incomplete_columns = y.columns.flatMap((c, col) => (c != null && c.imported < c.counted ? [col] : []));
  }
  return { cells, years };
}

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
    assertAllCcStatementPdfsResolvable();
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
  const rawCells = monthList.map((rowMonth) =>
    accounts.map((acc, accIdx) => {
      const file_path = byAccount[accIdx]?.filePaths.get(rowMonth) ?? null;
      const imported = hasImportSyncDocumentForMonth(acc, rowMonth);
      const file_sin_movimientos =
        acc.document_kind === "checking_cartola" ||
        acc.document_kind === "cuenta_vista_cartola"
          ? importSyncCartolaSinMovimientosForMonth({
              accountId: acc.account_id,
              documentKind: acc.document_kind,
              filePath: file_path,
            })
          : false;
      return { imported, file_path, file_sin_movimientos };
    })
  );

  const { cells, years } = buildImportSyncDocumentYears(monthList, accounts.length, rawCells, currentYm);
  return { months: monthList, accounts, cells, years };
}
