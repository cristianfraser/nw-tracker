import { ymCompare, monthKeyFromYmd } from "./calendarMonth.js";
import { chileCalendarTodayYmd } from "./chileDate.js";
import { assertCcStatementsHavePeriodTo } from "./ccStatementMetadata.js";
import {
  assertAllCcStatementPdfsResolvable,
  buildImportSyncDocumentMonths,
  hasImportSyncDocumentForMonth,
} from "./importSyncDocumentFilePath.js";
import { importSyncCartolaSinMovimientosForMonth } from "./importSyncCartolaSinMovimientos.js";
import { listImportSyncDocumentAccounts } from "./importSyncDocumentAccounts.js";
import { importSyncDocumentPathsByMonth, importSyncDocumentRef } from "./importSyncDocumentFile.js";
import { addCalendarMonths } from "nw-tracker-contracts";

import type { ImportSyncDocumentAccount } from "./importSyncDocumentTypes.js";
import type { ImportSyncDocumentRef } from "nw-tracker-contracts/dto/sync";

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
  /** The month's source file on disk, as the page opens it (`importSyncDocumentRef`). */
  document: ImportSyncDocumentRef | null;
  /** Cartola for this month has no imported movements (○ marker). */
  file_sin_movimientos?: boolean;
  state: ImportSyncDocumentCellState;
};

/**
 * One column's months of a year: those from its first document on, and how many are imported.
 * A column whose only month that year is the one in progress (not due) has `counted` 0.
 */
export type ImportSyncDocumentYearColumn = { counted: number; imported: number };

export type ImportSyncDocumentYear = {
  year: number;
  /** Indexes into `months` / `cells` of this year's months, newest first. */
  month_indexes: number[];
  /** Per column of `accounts`; null = the column has no document by this year. */
  columns: (ImportSyncDocumentYearColumn | null)[];
  /**
   * Columns with a counted month this year, and those with every counted month imported (both 0
   * in a year whose only month is the one in progress: nothing is due yet).
   */
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

/** A month's cell before the coverage marks the months before the first document and the one in progress. */
export type RawImportSyncDocumentCell = {
  imported: boolean;
  document: ImportSyncDocumentRef | null;
  file_sin_movimientos: boolean;
};

function cellState(c: RawImportSyncDocumentCell): Exclude<ImportSyncDocumentCellState, "before_first" | "not_due"> {
  if (c.imported) {
    if (c.file_sin_movimientos) return "no_movements";
    return c.document ? "imported" : "imported_no_file";
  }
  return c.document ? "file_not_imported" : "missing";
}

/**
 * Marks the months before each column's first document and the month in progress (`currentYm`)
 * while it has no document, and adds the rest up by year.
 */
export function buildImportSyncDocumentYears(
  months: string[],
  columnCount: number,
  rawCells: RawImportSyncDocumentCell[][],
  currentYm: string
): { cells: ImportSyncDocumentCell[][]; years: ImportSyncDocumentYear[] } {
  // `months` is newest first: a column's first document is its LAST row holding one.
  const firstRow = Array.from({ length: columnCount }, (_, col) => {
    for (let row = months.length - 1; row >= 0; row -= 1) {
      const c = rawCells[row]![col]!;
      if (c.imported || c.document) return row;
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
      if (c.state === "before_first") return;
      const column = (entry.columns[col] ??= { counted: 0, imported: 0 });
      if (c.state === "not_due") return;
      column.counted += 1;
      if (c.imported) column.imported += 1;
    });
  });
  for (const y of years) {
    const counted = y.columns.filter((c): c is ImportSyncDocumentYearColumn => c != null && c.counted > 0);
    y.columns_counted = counted.length;
    y.columns_complete = counted.filter((c) => c.imported === c.counted).length;
    y.incomplete_columns = y.columns.flatMap((c, col) => (c != null && c.imported < c.counted ? [col] : []));
  }
  return { cells, years };
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
  const accounts = listImportSyncDocumentAccounts();
  const currentYm = monthKeyFromYmd(chileCalendarTodayYmd());

  let earliestYm: string | null = null;
  const byAccount = accounts.map((acc) => {
    const filePaths = importSyncDocumentPathsByMonth(acc);
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
      const filePath = byAccount[accIdx]?.filePaths.get(rowMonth) ?? null;
      const imported = hasImportSyncDocumentForMonth(acc, rowMonth);
      const file_sin_movimientos =
        acc.document_kind === "checking_cartola" ||
        acc.document_kind === "cuenta_vista_cartola"
          ? importSyncCartolaSinMovimientosForMonth({
              accountId: acc.account_id,
              documentKind: acc.document_kind,
              filePath,
            })
          : false;
      const document = filePath == null ? null : importSyncDocumentRef(acc, rowMonth, filePath);
      return { imported, document, file_sin_movimientos };
    })
  );

  const { cells, years } = buildImportSyncDocumentYears(monthList, accounts.length, rawCells, currentYm);
  return { months: monthList, accounts, cells, years };
}
