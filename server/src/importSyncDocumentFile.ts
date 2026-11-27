/**
 * A coverage matrix cell's source file, as the page opens it: the column it belongs to, the
 * month's file on the server's disk, the links the payload hands the page, and a workbook's
 * rows as displayed text. The client names a column and a month, never a path or a file name.
 */
import fs from "node:fs";
import path from "node:path";
import XLSX from "xlsx";
import type {
  ImportSyncDocumentPreviewKind,
  ImportSyncDocumentRef,
  ImportSyncSheetPreviewResponse,
} from "nw-tracker-contracts/dto/sync";
import {
  resolveCfraserCheckingCartolaPdfsDir,
  resolveCfraserCheckingCartolasDir,
  resolveCfraserCuentaVistaCartolaPdfsDir,
  resolveCfraserPdfsDir,
} from "./cfraserPaths.js";
import { InputError } from "./inputError.js";
import { listImportSyncDocumentAccounts } from "./importSyncDocumentAccounts.js";
import { buildImportSyncDocumentPathsByMonth } from "./importSyncDocumentFilePath.js";
import type { CcStatementCoverageCurrency, ImportSyncDocumentAccount } from "./importSyncDocumentTypes.js";

export const IMPORT_SYNC_DOCUMENT_SLOTS = ["clp", "usd"] as const satisfies readonly CcStatementCoverageCurrency[]; // convention-ok: the statement PDF corpus is filed in clp/ and usd/ folders per card

const PREVIEW_KIND_BY_EXTENSION: Record<string, ImportSyncDocumentPreviewKind> = {
  ".pdf": "pdf",
  ".xlsx": "sheet",
};

const CONTENT_TYPE_BY_PREVIEW_KIND: Record<ImportSyncDocumentPreviewKind, string> = {
  pdf: "application/pdf",
  sheet: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
};

/** How the page shows a file, from its extension (any case); any other extension throws. */
export function importSyncDocumentPreviewKind(fileName: string): ImportSyncDocumentPreviewKind {
  const kind = PREVIEW_KIND_BY_EXTENSION[path.extname(fileName).toLowerCase()];
  if (!kind) throw new Error(`import-sync document ${fileName}: no preview for this file type (expected .pdf or .xlsx)`);
  return kind;
}

export function importSyncDocumentContentType(kind: ImportSyncDocumentPreviewKind): string {
  return CONTENT_TYPE_BY_PREVIEW_KIND[kind];
}

/**
 * The one column of `columns` that `(accountId, slot)` names: a card with CLP and USD columns
 * needs the slot, a column without a currency takes none. An account with no column is a 404,
 * a slot missing, unexpected or naming no column a 400 / 404 — never a guess.
 */
export function pickImportSyncDocumentColumn(
  columns: readonly ImportSyncDocumentAccount[],
  accountId: number,
  slot: CcStatementCoverageCurrency | null
): ImportSyncDocumentAccount {
  const ofAccount = columns.filter((c) => c.account_id === accountId);
  if (ofAccount.length === 0) throw new InputError(`account ${accountId} has no document column`, 404);
  const withSlot = ofAccount.filter((c) => c.cc_statement_currency != null);
  if (withSlot.length === 0) {
    if (slot != null) throw new InputError(`account ${accountId}'s documents take no slot`);
    if (ofAccount.length !== 1) throw new Error(`account ${accountId} has ${ofAccount.length} document columns without a slot`);
    return ofAccount[0]!;
  }
  if (withSlot.length !== ofAccount.length) {
    throw new Error(`account ${accountId} mixes document columns with and without a slot`);
  }
  if (slot == null) throw new InputError(`account ${accountId}'s documents need a slot (clp or usd)`);
  const matches = withSlot.filter((c) => c.cc_statement_currency === slot);
  if (matches.length === 0) throw new InputError(`account ${accountId} has no ${slot} document column`, 404);
  if (matches.length !== 1) throw new Error(`account ${accountId} has ${matches.length} ${slot} document columns`);
  return matches[0]!;
}

/** The matrix column `(accountId, slot)` names, among the columns the coverage lists. */
export function resolveImportSyncDocumentColumn(
  accountId: number,
  slot: CcStatementCoverageCurrency | null
): ImportSyncDocumentAccount {
  return pickImportSyncDocumentColumn(listImportSyncDocumentAccounts(), accountId, slot);
}

/** The folders a column's documents are filed under (the cartola folders, or the card statements' root). */
function documentRootsForKind(kind: ImportSyncDocumentAccount["document_kind"]): string[] {
  if (kind === "cc_statement") return [resolveCfraserPdfsDir()];
  if (kind === "cuenta_vista_cartola") return [resolveCfraserCuentaVistaCartolaPdfsDir()];
  return [resolveCfraserCheckingCartolasDir(), resolveCfraserCheckingCartolaPdfsDir()];
}

/**
 * The real path of a column's document, which must be a regular file inside one of the kind's
 * folders (both sides resolved through symlinks). Anything else is an integrity failure that
 * throws: a stored absolute path or a symlink leading out of the folders is never served.
 */
export function containedImportSyncDocumentPath(kind: ImportSyncDocumentAccount["document_kind"], absPath: string): string {
  const real = fs.realpathSync(absPath);
  if (!fs.statSync(real).isFile()) throw new Error(`import-sync document ${path.basename(absPath)} is not a regular file`);
  for (const root of documentRootsForKind(kind)) {
    if (!fs.existsSync(root)) continue;
    const rel = path.relative(fs.realpathSync(root), real);
    if (rel !== "" && !rel.startsWith(`..${path.sep}`) && rel !== ".." && !path.isAbsolute(rel)) return real;
  }
  throw new Error(`import-sync document ${path.basename(absPath)} lies outside the ${kind} document folders`);
}

/**
 * `row_month` → the real path of the column's file, every path checked by
 * `containedImportSyncDocumentPath`: the one month → file map the coverage cells and the documents
 * route both read, so a cell never links a file the route would refuse.
 */
export function importSyncDocumentPathsByMonth(column: ImportSyncDocumentAccount): Map<string, string> {
  return new Map(
    [...buildImportSyncDocumentPathsByMonth(column)].map(([ym, abs]) => [
      ym,
      containedImportSyncDocumentPath(column.document_kind, abs),
    ])
  );
}

export type ImportSyncDocumentFile = {
  abs_path: string;
  file_name: string;
  preview_kind: ImportSyncDocumentPreviewKind;
};

/** A column's file for `month` (`YYYY-MM`), as the coverage finds it; a month with none is a 404. */
export function resolveImportSyncDocumentFile(column: ImportSyncDocumentAccount, month: string): ImportSyncDocumentFile {
  const absPath = importSyncDocumentPathsByMonth(column).get(month);
  if (absPath == null) throw new InputError(`no document on disk for account ${column.account_id} in ${month}`, 404);
  const fileName = path.basename(absPath);
  return { abs_path: absPath, file_name: fileName, preview_kind: importSyncDocumentPreviewKind(fileName) };
}

function documentHref(column: ImportSyncDocumentAccount, month: string, leaf: "file" | "sheet", download = false): string {
  const params = new URLSearchParams();
  if (column.cc_statement_currency != null) params.set("slot", column.cc_statement_currency);
  if (download) params.set("download", "1");
  const query = params.toString();
  return `/api/import-sync/documents/${column.account_id}/${month}/${leaf}${query ? `?${query}` : ""}`;
}

/** The links a cell hands the page for its month's file (`absPath`, as the coverage found it). */
export function importSyncDocumentRef(column: ImportSyncDocumentAccount, month: string, absPath: string): ImportSyncDocumentRef {
  const fileName = path.basename(absPath);
  const links = {
    file_name: fileName,
    view_href: documentHref(column, month, "file"),
    download_href: documentHref(column, month, "file", true),
  };
  return importSyncDocumentPreviewKind(fileName) === "sheet"
    ? { ...links, preview_kind: "sheet", sheet_href: documentHref(column, month, "sheet") }
    : { ...links, preview_kind: "pdf", sheet_href: null };
}

/** A workbook larger than this is not read into a preview (413). */
export const IMPORT_SYNC_SHEET_PREVIEW_MAX_BYTES = 20 * 1024 * 1024;
/** A preview with more cells than this, every sheet counted from A1 to its last filled cell, is a 413. */
export const IMPORT_SYNC_SHEET_PREVIEW_MAX_CELLS = 200_000;

const pad2 = (n: number) => String(n).padStart(2, "0");

/**
 * One cell as the preview shows it: text as its text, a number as the raw number, a number with a
 * date format as `YYYY-MM-DD` (`YYYY-MM-DD HH:MM` with a time part, `HH:MM` for a time alone, a
 * serial under 1; read from the serial by SheetJS's calendar in the workbook's date system, never
 * through a `Date`, so no timezone moves a day), a boolean or an error as its displayed text, an
 * empty cell "".
 */
function previewCell(cell: XLSX.CellObject, date1904: boolean, ctx: string): string | number {
  switch (cell.t) {
    case "z":
      return "";
    case "s":
      return String(cell.v ?? "");
    case "b":
    case "e":
      if (cell.w == null) throw new Error(`${ctx}: ${cell.t === "b" ? "boolean" : "error"} cell without displayed text`);
      return cell.w;
    case "n": {
      const v = Number(cell.v);
      if (!cell.z || !XLSX.SSF.is_date(cell.z)) return v;
      const d = XLSX.SSF.parse_date_code(v, { date1904 });
      if (!d) throw new Error(`${ctx}: date serial ${v} out of range`);
      const time = `${pad2(d.H)}:${pad2(d.M)}`;
      if (v >= 0 && v < 1) return time;
      const day = `${d.y}-${pad2(d.m)}-${pad2(d.d)}`;
      return d.H === 0 && d.M === 0 && d.S === 0 ? day : `${day} ${time}`;
    }
    default:
      throw new Error(`${ctx}: unexpected cell type ${cell.t}`);
  }
}

const tooLarge = (fileName: string, what: string) =>
  new InputError(`${fileName} is ${what}, over the preview limit (download it instead)`, 413);

/**
 * Every sheet of a workbook (hidden ones too), each cell by `previewCell`, from A1 to the last
 * row and column holding a non-empty cell: the extent comes from the cells themselves, never the
 * sheet's declared dimension. Over `IMPORT_SYNC_SHEET_PREVIEW_MAX_BYTES` or
 * `IMPORT_SYNC_SHEET_PREVIEW_MAX_CELLS` it is a 413.
 */
export function readImportSyncSheetPreview(absPath: string): ImportSyncSheetPreviewResponse {
  const fileName = path.basename(absPath);
  if (importSyncDocumentPreviewKind(fileName) !== "sheet") {
    throw new InputError(`${fileName} is not a workbook`);
  }
  const size = fs.statSync(absPath).size;
  if (size > IMPORT_SYNC_SHEET_PREVIEW_MAX_BYTES) {
    throw tooLarge(fileName, `${(size / 1024 / 1024).toFixed(1)} MB (limit ${IMPORT_SYNC_SHEET_PREVIEW_MAX_BYTES / 1024 / 1024} MB)`);
  }
  const wb = XLSX.read(fs.readFileSync(absPath), { cellNF: true });
  if (wb.SheetNames.length === 0) throw new Error(`${fileName}: the workbook has no sheets`);
  const date1904 = Boolean(wb.Workbook?.WBProps?.date1904);
  let totalCells = 0;
  const filled = wb.SheetNames.map((name) => {
    const ws = wb.Sheets[name];
    if (!ws) throw new Error(`${fileName}: sheet ${name} is listed but missing`);
    const cells: { r: number; c: number; value: string | number }[] = [];
    let lastRow = -1;
    let lastCol = -1;
    for (const address of Object.keys(ws)) {
      if (address.startsWith("!")) continue;
      const value = previewCell(ws[address] as XLSX.CellObject, date1904, `${fileName} ${name}!${address}`);
      if (value === "") continue;
      const { r, c } = XLSX.utils.decode_cell(address);
      cells.push({ r, c, value });
      lastRow = Math.max(lastRow, r);
      lastCol = Math.max(lastCol, c);
    }
    totalCells += (lastRow + 1) * (lastCol + 1);
    return { name, cells, lastRow, lastCol };
  });
  if (totalCells > IMPORT_SYNC_SHEET_PREVIEW_MAX_CELLS) {
    throw tooLarge(fileName, `${totalCells} cells (limit ${IMPORT_SYNC_SHEET_PREVIEW_MAX_CELLS})`);
  }
  const sheets = filled.map(({ name, cells, lastRow, lastCol }) => {
    const rows: (string | number)[][] = Array.from({ length: lastRow + 1 }, () =>
      Array.from({ length: lastCol + 1 }, (): string | number => "")
    );
    for (const { r, c, value } of cells) rows[r]![c] = value;
    return { name, rows };
  });
  return { file_name: fileName, sheets };
}

/** What a failed `res.sendFile` does next (`documentSendFailure`). */
export type DocumentSendFailure =
  | { action: "ignore" }
  | { action: "destroy" }
  | { action: "not_found" }
  | { action: "client_error"; status: number; headers: Record<string, string> }
  | { action: "fail" };

/**
 * How a failed `res.sendFile` ends: a dropped connection is nothing, an error once the file is
 * streaming ends the response, a file gone from disk is a JSON 404, another 4xx of `send` (416
 * range not satisfiable, with its `Content-Range`; 412 precondition failed) that status as JSON,
 * anything else the 500.
 */
export function documentSendFailure(
  err: { code?: string; status?: number; statusCode?: number; headers?: Record<string, unknown> },
  headersSent: boolean
): DocumentSendFailure {
  if (err.code === "ECONNABORTED") return { action: "ignore" };
  if (headersSent) return { action: "destroy" };
  const status = err.status ?? err.statusCode;
  if (err.code === "ENOENT" || status === 404) return { action: "not_found" };
  if (status != null && status >= 400 && status < 500) {
    const headers: Record<string, string> = {};
    const contentRange = err.headers?.["Content-Range"];
    if (status === 416 && contentRange != null) headers["Content-Range"] = String(contentRange);
    return { action: "client_error", status, headers };
  }
  return { action: "fail" };
}

/**
 * `Content-Disposition` for a file name with spaces and non-ASCII letters (RFC 6266 / 5987): an
 * ASCII `filename` for old clients, the exact name in `filename*`.
 */
export function importSyncDocumentContentDisposition(type: "inline" | "attachment", fileName: string): string {
  const ascii = fileName
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\x20-\x7e]|["\\%]/g, "_");
  const encoded = encodeURIComponent(fileName).replace(
    /['()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`
  );
  return `${type}; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}
