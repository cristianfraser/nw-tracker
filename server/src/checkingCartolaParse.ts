import fs from "node:fs";
import path from "node:path";
import XLSX from "xlsx";

const SPANISH_MONTH: Record<string, number> = {
  enero: 1,
  febrero: 2,
  marzo: 3,
  abril: 4,
  mayo: 5,
  junio: 6,
  julio: 7,
  agosto: 8,
  septiembre: 9,
  octubre: 10,
  noviembre: 11,
  diciembre: 12,
};

const COL_SALDO = 6;

export type ParsedCheckingMovement = {
  occurred_on: string;
  amount_clp: number;
  branch: string;
  description: string;
  document_no: string;
};

export type CartolaSkipReason =
  | "not_movement_row"
  | "invalid_date"
  | "no_amount"
  | "duplicate_in_cartola"
  | "end_of_table"
  | "balance_mismatch";

export type CartolaSkippedRow = {
  sheet_row?: number;
  fecha?: string;
  branch?: string;
  description?: string;
  document_no?: string;
  amount_clp?: number;
  reason: CartolaSkipReason;
  detail?: string;
};

export type CartolaParseNote = {
  sheet_row: number;
  message: string;
};

export type ParsedCheckingCartola = {
  source_file: string;
  period_month: string;
  period_from: string | null;
  period_to: string | null;
  saldo_inicial_clp: number | null;
  saldo_final_clp: number | null;
  movements: ParsedCheckingMovement[];
  skipped: CartolaSkippedRow[];
  notes: CartolaParseNote[];
};

function cell(row: unknown[], i: number): string {
  const v = row[i];
  if (v == null) return "";
  return String(v).trim();
}

/** Chilean bank amounts: $1.651.718 or plain digits. */
export function parseCartolaAmount(raw: string): number | null {
  const t = String(raw ?? "")
    .trim()
    .replace(/\$/g, "")
    .replace(/\s+/g, "");
  if (!t) return null;
  const normalized =
    /,\d{1,2}$/.test(t) && t.includes(".")
      ? t.replace(/\./g, "").replace(",", ".")
      : t.replace(/\./g, "");
  const n = Number(normalized);
  if (!Number.isFinite(n)) return null;
  return Math.round(n);
}

/** Last calendar day of month (1–12) as YYYY-MM-DD. */
export function cartolaFileNameDatePrefix(year: number, month1to12: number): string {
  const lastDay = new Date(Date.UTC(year, month1to12, 0)).getUTCDate();
  return `${year}-${String(month1to12).padStart(2, "0")}-${String(lastDay).padStart(2, "0")}`;
}

export function periodMonthFromCartolaFileName(fileName: string): string | null {
  const dated = /^(\d{4})-(\d{2})-\d{2}(?:\s|_)/.exec(fileName);
  if (dated) {
    const y = Number(dated[1]);
    const mo = Number(dated[2]);
    if (Number.isFinite(y) && mo >= 1 && mo <= 12) {
      return `${y}-${String(mo).padStart(2, "0")}`;
    }
  }
  const m = /-\s*([A-Za-zÁÉÍÓÚáéíóúñÑ]+)\s+(\d{4})\s*\.xlsx$/i.exec(fileName);
  if (!m) return null;
  const monthName = m[1]!
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{M}/gu, "");
  const mo = SPANISH_MONTH[monthName];
  const y = Number(m[2]);
  if (!mo || !Number.isFinite(y)) return null;
  return `${y}-${String(mo).padStart(2, "0")}`;
}

function parseDdMmYyyy(raw: string): string | null {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(String(raw ?? "").trim());
  if (!m) return null;
  const d = Number(m[1]);
  const mo = Number(m[2]);
  const y = Number(m[3]);
  if (d < 1 || d > 31 || mo < 1 || mo > 12) return null;
  return `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

function parseDdMmWithPeriodYear(ddMm: string, periodMonth: string): string | null {
  const m = /^(\d{1,2})\/(\d{1,2})$/.exec(String(ddMm ?? "").trim());
  if (!m) return null;
  const d = Number(m[1]);
  const mo = Number(m[2]);
  const [ys] = periodMonth.split("-");
  const y = Number(ys);
  if (!Number.isFinite(y) || d < 1 || d > 31 || mo < 1 || mo > 12) return null;
  return `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

function findLabelAmount(rows: unknown[][], label: string): number | null {
  for (const row of rows) {
    const c0 = cell(row, 0);
    if (!c0.toLowerCase().startsWith(label.toLowerCase())) continue;
    return parseCartolaAmount(cell(row, 1));
  }
  return null;
}

function rowLooksLikeMovementData(row: unknown[]): boolean {
  const fecha = cell(row, 0);
  if (/^\d{1,2}\/\d{1,2}$/.test(fecha)) return true;
  if (parseCartolaAmount(cell(row, 4)) != null || parseCartolaAmount(cell(row, 5)) != null) {
    return true;
  }
  if (parseCartolaAmount(cell(row, COL_SALDO)) != null) return true;
  if (cell(row, 2).trim() || cell(row, 3).trim()) return true;
  return false;
}

function pushSkip(skipped: CartolaSkippedRow[], entry: CartolaSkippedRow): void {
  skipped.push(entry);
}

function isMovementStopRow(row: unknown[]): boolean {
  const c0 = cell(row, 0).toLowerCase();
  const c2 = cell(row, 2).toLowerCase();
  if (!c0 && !c2) return true;
  if (c0 === "mensajes" || c0.startsWith("sr.cliente")) return true;
  if (c2.includes("resumen de comisiones") || c2.startsWith("***")) return true;
  return false;
}

/** Identity key for optional duplicate removal when saldo checkpoints fail. */
export function cartolaMovementDedupeKey(mv: {
  occurred_on: string;
  amount_clp: number;
  description: string;
  document_no?: string;
}): string {
  const doc = String(mv.document_no ?? "").trim();
  return `${mv.occurred_on}\t${mv.amount_clp}\t${mv.description}\t${doc}`;
}

export function movementNote(
  periodMonth: string,
  branch: string,
  description: string,
  documentNo: string
): string {
  const parts = [
    `import:cartola|${periodMonth}`,
    branch || "—",
    description.slice(0, 180),
  ];
  if (documentNo) parts.push(`doc:${documentNo}`);
  return parts.join("|");
}

type RowAmountEntry = { kind: "cargo" | "abono"; amount: number };

function buildRowAmountEntries(
  cargo: number | null,
  abono: number | null,
  saldoCell: number | null,
  runningBeforeRow: number,
  notes: CartolaParseNote[],
  sheetRow: number
): RowAmountEntry[] {
  const entries: RowAmountEntry[] = [];
  if (cargo != null && cargo > 0) entries.push({ kind: "cargo", amount: -cargo });
  if (abono != null && abono > 0) entries.push({ kind: "abono", amount: abono });

  if (entries.length === 0 && saldoCell != null) {
    const delta = saldoCell - runningBeforeRow;
    if (delta !== 0) {
      const kind = delta > 0 ? "abono" : "cargo";
      entries.push({ kind, amount: delta });
      notes.push({
        sheet_row: sheetRow,
        message: `inferred ${kind} ${Math.abs(delta)} CLP from saldo column (running ${runningBeforeRow} → ${saldoCell})`,
      });
    }
  }
  return entries;
}

/**
 * Drop the last movement when it is identical to the previous one and removing it
 * makes the running balance match the printed saldo on this row (true duplicate line).
 */
function tryDropSaldoDuplicateTail(
  movements: ParsedCheckingMovement[],
  runningBalance: number,
  saldoCell: number
): { dropped: ParsedCheckingMovement | null; running: number } {
  if (movements.length < 2) return { dropped: null, running: runningBalance };
  const last = movements[movements.length - 1]!;
  const prev = movements[movements.length - 2]!;
  if (cartolaMovementDedupeKey(last) !== cartolaMovementDedupeKey(prev)) {
    return { dropped: null, running: runningBalance };
  }
  const runningWithoutLast = runningBalance - last.amount_clp;
  if (runningWithoutLast !== saldoCell) return { dropped: null, running: runningBalance };
  movements.pop();
  return { dropped: last, running: runningWithoutLast };
}

export function parseCheckingCartolaWorkbook(
  workbook: XLSX.WorkBook,
  sourceFile: string
): ParsedCheckingCartola {
  const periodMonth = periodMonthFromCartolaFileName(sourceFile);
  if (!periodMonth) {
    throw new Error(`Cannot infer period month from file name: ${sourceFile}`);
  }

  const sheetName =
    workbook.SheetNames.find((n) => /cartola/i.test(n)) ?? workbook.SheetNames[0];
  if (!sheetName) {
    throw new Error(`No sheets in ${sourceFile}`);
  }

  const rows = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName]!, {
    header: 1,
    defval: "",
  }) as unknown[][];

  let periodFrom: string | null = null;
  let periodTo: string | null = null;
  for (const row of rows) {
    const label = cell(row, 4).toLowerCase();
    if (label === "desde") periodFrom = parseDdMmYyyy(cell(row, 5));
    if (label === "hasta") periodTo = parseDdMmYyyy(cell(row, 5));
  }

  const saldoInicial = findLabelAmount(rows, "Saldo inicial:");
  const saldoFinal = findLabelAmount(rows, "Saldo final:");

  const headerIdx = rows.findIndex((r) => cell(r, 0).toUpperCase() === "FECHA");
  if (headerIdx < 0) {
    throw new Error(`Movement table header not found in ${sourceFile}`);
  }

  const movements: ParsedCheckingMovement[] = [];
  const skipped: CartolaSkippedRow[] = [];
  const notes: CartolaParseNote[] = [];
  let runningBalance = saldoInicial ?? 0;

  for (let i = headerIdx + 1; i < rows.length; i++) {
    const row = rows[i]!;
    const sheetRow = i + 1;
    if (isMovementStopRow(row)) {
      if (rowLooksLikeMovementData(row)) {
        pushSkip(skipped, {
          sheet_row: sheetRow,
          fecha: cell(row, 0) || undefined,
          description: cell(row, 2) || undefined,
          reason: "end_of_table",
          detail: "stopped at footer/resumen row",
        });
      }
      break;
    }

    const fecha = cell(row, 0);
    if (!fecha || !/^\d{1,2}\/\d{1,2}$/.test(fecha)) {
      if (rowLooksLikeMovementData(row)) {
        pushSkip(skipped, {
          sheet_row: sheetRow,
          fecha: fecha || undefined,
          branch: cell(row, 1) || undefined,
          description: cell(row, 2) || undefined,
          document_no: cell(row, 3) || undefined,
          reason: "not_movement_row",
          detail: "missing or invalid FECHA (expected DD/MM)",
        });
      }
      continue;
    }

    const branch = cell(row, 1);
    const description = cell(row, 2);
    const documentNo = cell(row, 3);
    const occurredOn = parseDdMmWithPeriodYear(fecha, periodMonth);
    if (!occurredOn) {
      pushSkip(skipped, {
        sheet_row: sheetRow,
        fecha,
        branch: branch || undefined,
        description: description || undefined,
        document_no: documentNo || undefined,
        reason: "invalid_date",
        detail: `could not resolve date in period ${periodMonth}`,
      });
      continue;
    }

    const cargo = parseCartolaAmount(cell(row, 4));
    const abono = parseCartolaAmount(cell(row, 5));
    const saldoCell = parseCartolaAmount(cell(row, COL_SALDO));
    const runningBeforeRow = runningBalance;

    const entries = buildRowAmountEntries(
      cargo,
      abono,
      saldoCell,
      runningBeforeRow,
      notes,
      sheetRow
    );

    if (entries.length === 0) {
      pushSkip(skipped, {
        sheet_row: sheetRow,
        fecha,
        branch: branch || undefined,
        description: description || undefined,
        document_no: documentNo || undefined,
        reason: "no_amount",
        detail: "no cargo, abono, or saldo-implied amount on movement row",
      });
      continue;
    }

    for (const { kind, amount } of entries) {
      movements.push({
        occurred_on: occurredOn,
        amount_clp: amount,
        branch,
        description,
        document_no: documentNo,
      });
      runningBalance += amount;
    }

    if (saldoCell != null) {
      if (runningBalance !== saldoCell) {
        const { dropped, running } = tryDropSaldoDuplicateTail(
          movements,
          runningBalance,
          saldoCell
        );
        if (dropped) {
          runningBalance = running;
          pushSkip(skipped, {
            sheet_row: sheetRow,
            fecha,
            branch: branch || undefined,
            description: description || undefined,
            document_no: documentNo || undefined,
            amount_clp: dropped.amount_clp,
            reason: "duplicate_in_cartola",
            detail:
              "removed duplicate line: running balance matched saldo only without this movement",
          });
        }
      }
      if (runningBalance !== saldoCell) {
        pushSkip(skipped, {
          sheet_row: sheetRow,
          fecha,
          branch: branch || undefined,
          description: description || undefined,
          document_no: documentNo || undefined,
          reason: "balance_mismatch",
          detail: `running ${runningBalance} CLP ≠ saldo column ${saldoCell} CLP after row`,
        });
      }
      runningBalance = saldoCell;
    }
  }

  if (saldoFinal != null && runningBalance !== saldoFinal) {
    pushSkip(skipped, {
      reason: "balance_mismatch",
      detail: `ledger running ${runningBalance} CLP ≠ saldo final ${saldoFinal} CLP after all movements`,
    });
  }

  return {
    source_file: sourceFile,
    period_month: periodMonth,
    period_from: periodFrom,
    period_to: periodTo,
    saldo_inicial_clp: saldoInicial,
    saldo_final_clp: saldoFinal,
    movements,
    skipped,
    notes,
  };
}

export function parseCheckingCartolaFile(filePath: string): ParsedCheckingCartola {
  const buf = fs.readFileSync(filePath);
  const wb = XLSX.read(buf, { type: "buffer", cellDates: false });
  return parseCheckingCartolaWorkbook(wb, path.basename(filePath));
}

export function listCheckingCartolaXlsxFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.toLowerCase().endsWith(".xlsx"))
    .sort((a, b) => {
      const ma = periodMonthFromCartolaFileName(a) ?? "";
      const mb = periodMonthFromCartolaFileName(b) ?? "";
      return ma.localeCompare(mb);
    })
    .map((f) => path.join(dir, f));
}
