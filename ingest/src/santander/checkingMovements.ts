import fs from "node:fs";
import path from "node:path";
import XLSX from "xlsx";
import type {
  BankAccountMovement,
  BankAccountMovementsApplyDetails,
  BankAccountMovementsPayload,
} from "nw-tracker-contracts";
import { resolveInboxDir } from "../paths.js";
import { isChileanNumber, parseChileanNumber } from "../formats/chileanNumber.js";

/**
 * Santander's «ultimos movimientos-Cuenta Corriente.xlsx» (the checking account's recent
 * movements, downloaded by `fetch:santander`, or uploaded on the card page) → a
 * `bank_account.movements` payload. Rows: the holder's name · `<product>: <account number>` ·
 * the header «Fecha · Detalle · Monto cargo ($) · Monto abono ($) · Saldo ($)» · the movements
 * (Fecha dd-mm-yyyy).
 *
 * Only the PESO account's workbook is accepted (2026-10-09): the bank's dollar cuenta corriente
 * downloads under the same name with «Monto cargo (USD)» headers, and every row used to be sent
 * as pesos into the peso account. The headers must be the «($)» ones and row 2 must carry an
 * account number, which travels in the payload for the server to check against the account it
 * maps the listing to.
 */

function cell(row: unknown[], i: number): string {
  const v = row[i];
  if (v == null) return "";
  return String(v).trim();
}

/** A cartola amount cell: «$ 1.234», «1.234», blank. Null when the cell holds no number. */
function amountCell(raw: string): number | null {
  const t = String(raw ?? "").replace(/\$/g, "");
  if (!isChileanNumber(t)) return null;
  return Math.round(parseChileanNumber(t));
}

// dd-mm-yyyy, and the date may be AFTER today: Santander's bank day ends at 14:00, so a wire
// received or sent after the cutoff posts on the NEXT WORKDAY (Friday 15:00 → Monday). Keep the
// bank's date as-is — it is the canonical posting date the monthly cartola will repeat, which is
// what lets the cartola import dedupe against these incremental rows.
function parseDdMmYyyyDash(raw: string): string | null {
  const m = /^(\d{1,2})-(\d{1,2})-(\d{4})$/.exec(String(raw ?? "").trim());
  if (!m) return null;
  const d = Number(m[1]);
  const mo = Number(m[2]);
  const y = Number(m[3]);
  if (d < 1 || d > 31 || mo < 1 || mo > 12) return null;
  return `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

function normalizeDescription(s: string): string {
  return s.replace(/\s+/g, " ").trim().slice(0, 180);
}

function isHeader(row: unknown[]): boolean {
  return cell(row, 0).toLowerCase() === "fecha" && cell(row, 1).toLowerCase() === "detalle";
}

/** The amount headers of the peso workbook; the dollar account's read «Monto cargo (USD)». */
const PESO_CARGO_HEADER = /^monto\s+cargo\s*\(\$\)$/i;
const PESO_ABONO_HEADER = /^monto\s+abono\s*\(\$\)$/i;
/** Row 2: `<product name>: <account number as the bank formats it>`, e.g. «Cuenta Corriente: 0-000-00-00000-0». */
const ACCOUNT_LINE = /^([^:]+):\s*([\d\s-]+)$/;

export type UltimosMovimientosHeader = {
  /** Index of the «Fecha / Detalle» header row. */
  headerRow: number;
  /** The account number row 2 names, digits only (leading zeros as printed). */
  accountNumber: string;
  /** The product name row 2 names («Cuenta Corriente»). */
  productLabel: string;
};

/**
 * The workbook's identity, or an error naming what is wrong: the amount headers must be the peso
 * «($)» ones, and the line above the header must name an account number.
 */
export function readUltimosMovimientosHeader(rows: unknown[][]): UltimosMovimientosHeader {
  const headerRow = rows.findIndex((row) => Array.isArray(row) && isHeader(row));
  if (headerRow < 0) throw new Error("Not a Santander «ultimos movimientos» workbook (no Fecha / Detalle header)");
  const header = rows[headerRow] as unknown[];
  const cargo = cell(header, 2);
  const abono = cell(header, 3);
  if (!PESO_CARGO_HEADER.test(cargo) || !PESO_ABONO_HEADER.test(abono)) {
    throw new Error(
      `Not the peso cuenta corriente's «ultimos movimientos» workbook: amount headers are «${cargo}» / «${abono}», expected «Monto cargo ($)» / «Monto abono ($)» (a dollar account's listing is refused here)`,
    );
  }
  const accountLine = rows
    .slice(0, headerRow)
    .map((row) => (Array.isArray(row) ? cell(row, 0) : ""))
    .map((text) => ACCOUNT_LINE.exec(text))
    .find((m): m is RegExpExecArray => m !== null && m[2]!.replace(/\D/g, "").length > 0);
  if (!accountLine) {
    throw new Error("Santander «ultimos movimientos» workbook names no account number above its header (expected «<product>: <number>»)");
  }
  return { headerRow, accountNumber: accountLine[2]!.replace(/\D/g, ""), productLabel: accountLine[1]!.trim() };
}

export function workbookRows(buffer: Buffer): unknown[][] {
  const wb = XLSX.read(buffer, { type: "buffer" });
  const sheetName = wb.SheetNames[0];
  if (!sheetName) return [];
  return XLSX.utils.sheet_to_json(wb.Sheets[sheetName]!, { header: 1, defval: "" }) as unknown[][];
}

/** The workbook's shape: a «Fecha / Detalle» header in its first rows. */
export function isUltimosMovimientosWorkbook(rows: unknown[][]): boolean {
  return rows.slice(0, 8).some((row) => Array.isArray(row) && isHeader(row));
}

export type UltimosMovimientosParse = {
  movements: BankAccountMovement[];
  /** Rows that could not be read, as the import reports them. */
  rejected_rows: string[];
};

/** The movements below the header. Throws through `readUltimosMovimientosHeader` on a workbook that is not the peso account's. */
export function parseUltimosMovimientosRows(rows: unknown[][]): UltimosMovimientosParse {
  const movements: BankAccountMovement[] = [];
  const rejected: string[] = [];
  const { headerRow } = readUltimosMovimientosHeader(rows);

  const seen = new Set<string>();
  const push = (date: string, description: string, amount: number, document_no: string | null) => {
    const key = `${date}\t${amount}\t${description}`;
    if (seen.has(key)) return;
    seen.add(key);
    movements.push({ date, description, currency: "clp", amount, document_no });
  };

  for (let i = headerRow + 1; i < rows.length; i++) {
    const row = rows[i] as unknown[];
    const fecha = cell(row, 0);
    const detalle = cell(row, 1);
    const cargo = amountCell(cell(row, 2));
    const abono = amountCell(cell(row, 3));
    if (!fecha && !detalle && cargo == null && abono == null) continue;

    const date = parseDdMmYyyyDash(fecha);
    if (!date) {
      if (fecha || detalle) rejected.push(`Fila ${i + 1}: fecha inválida (${fecha || "vacía"})`);
      continue;
    }
    const description = normalizeDescription(detalle);
    if (!description) {
      rejected.push(`Fila ${i + 1}: detalle vacío`);
      continue;
    }
    const document_no = /^(\d+)\s/.exec(description)?.[1] ?? null;
    if (cargo != null && cargo > 0) push(date, description, -cargo, document_no);
    if (abono != null && abono > 0) push(date, description, abono, document_no);
    if (cargo == null && abono == null) {
      rejected.push(`Fila ${i + 1}: sin monto cargo ni abono (${description.slice(0, 40)})`);
    }
  }
  return { movements, rejected_rows: rejected };
}

/**
 * The rows as one payload; throws when they are not the peso account's «últimos movimientos»
 * workbook. The account number row 2 names rides along for the server to check.
 */
export function ultimosMovimientosPayload(rows: unknown[][]): BankAccountMovementsPayload {
  const { accountNumber } = readUltimosMovimientosHeader(rows);
  const parsed = parseUltimosMovimientosRows(rows);
  return { account: { issuer: "santander", product: "checking", number: accountNumber }, ...parsed };
}

/** The whole workbook as one payload; throws when it is not the peso account's «últimos movimientos» workbook. */
export function santanderCheckingMovementsPayload(buffer: Buffer): BankAccountMovementsPayload {
  return ultimosMovimientosPayload(workbookRows(buffer));
}

/** The browser may suffix a re-download (` (1)`), so the match is prefix-based. */
const FILE_RE = /^ultimos movimientos.*\.xlsx$/i;

export function stagedCheckingMovementFiles(dir = resolveInboxDir()): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((name) => FILE_RE.test(name.trim()))
    .map((name) => path.join(dir, name))
    .sort((a, b) => fs.statSync(a).mtimeMs - fs.statSync(b).mtimeMs);
}

/** One line per file with every non-zero skip reason (a row absorbed by a transfer leg included). */
export function formatCheckingFileSummary(file: string, d: BankAccountMovementsApplyDetails, archivedTo: string | null): string {
  const parsed =
    d.inserted + d.skipped_duplicate + d.skipped_superseded_by_cartola + d.skipped_superseded_by_transfer + d.skipped_superseded_by_mail;
  const parts = [`${d.inserted} inserted`, `${d.skipped_duplicate} duplicate(s)`];
  if (d.skipped_superseded_by_cartola > 0) parts.push(`${d.skipped_superseded_by_cartola} superseded by cartola`);
  if (d.skipped_superseded_by_transfer > 0) parts.push(`${d.skipped_superseded_by_transfer} superseded by transfer`);
  if (d.skipped_superseded_by_mail > 0) parts.push(`${d.skipped_superseded_by_mail} already entered from its transfer mail`);
  return `${file}: ${parsed} row(s) parsed, ${parts.join(", ")}${archivedTo ? `; archived ${archivedTo}` : ""}`;
}
