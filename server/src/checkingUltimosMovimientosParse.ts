import XLSX from "xlsx";
import { parseCartolaAmount } from "./checkingCartolaParse.js";

export type UltimosMovimientoRow = {
  occurred_on: string;
  description: string;
  amount_clp: number;
  document_no: string;
};

export type UltimosMovimientosParseResult = {
  source_file: string;
  movements: UltimosMovimientoRow[];
  errors: string[];
};

function cell(row: unknown[], i: number): string {
  const v = row[i];
  if (v == null) return "";
  return String(v).trim();
}

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

export function isUltimosMovimientosWorkbook(rows: unknown[][]): boolean {
  for (let i = 0; i < Math.min(rows.length, 8); i++) {
    const row = rows[i] as unknown[] | undefined;
    if (!row) continue;
    const c0 = cell(row, 0).toLowerCase();
    if (c0 === "fecha" && cell(row, 1).toLowerCase() === "detalle") return true;
  }
  return false;
}

export function parseUltimosMovimientosBuffer(
  buffer: Buffer,
  sourceFile: string
): UltimosMovimientosParseResult {
  const wb = XLSX.read(buffer, { type: "buffer" });
  const sheetName = wb.SheetNames[0];
  if (!sheetName) {
    return { source_file: sourceFile, movements: [], errors: ["Workbook vacío"] };
  }
  const rows = XLSX.utils.sheet_to_json(wb.Sheets[sheetName]!, {
    header: 1,
    defval: "",
  }) as unknown[][];

  return parseUltimosMovimientosRows(rows, sourceFile);
}

export function parseUltimosMovimientosRows(
  rows: unknown[][],
  sourceFile: string
): UltimosMovimientosParseResult {
  const movements: UltimosMovimientoRow[] = [];
  const errors: string[] = [];
  let headerRow = -1;

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i] as unknown[];
    if (cell(row, 0).toLowerCase() === "fecha" && cell(row, 1).toLowerCase() === "detalle") {
      headerRow = i;
      break;
    }
  }

  if (headerRow < 0) {
    return { source_file: sourceFile, movements: [], errors: ["No se encontró fila de encabezados Fecha/Detalle"] };
  }

  const seen = new Set<string>();

  for (let i = headerRow + 1; i < rows.length; i++) {
    const row = rows[i] as unknown[];
    const fecha = cell(row, 0);
    const detalle = cell(row, 1);
    const cargo = parseCartolaAmount(cell(row, 2));
    const abono = parseCartolaAmount(cell(row, 3));

    if (!fecha && !detalle && cargo == null && abono == null) continue;

    const occurred_on = parseDdMmYyyyDash(fecha);
    if (!occurred_on) {
      if (fecha || detalle) errors.push(`Fila ${i + 1}: fecha inválida (${fecha || "vacía"})`);
      continue;
    }

    const description = normalizeDescription(detalle);
    if (!description) {
      errors.push(`Fila ${i + 1}: detalle vacío`);
      continue;
    }

    const docMatch = /^(\d+)\s/.exec(description);
    const document_no = docMatch?.[1] ?? "";

    if (cargo != null && cargo > 0) {
      const amount_clp = -Math.round(cargo);
      const key = `${occurred_on}\t${amount_clp}\t${description}`;
      if (!seen.has(key)) {
        seen.add(key);
        movements.push({ occurred_on, description, amount_clp, document_no });
      }
    }
    if (abono != null && abono > 0) {
      const amount_clp = Math.round(abono);
      const key = `${occurred_on}\t${amount_clp}\t${description}`;
      if (!seen.has(key)) {
        seen.add(key);
        movements.push({ occurred_on, description, amount_clp, document_no });
      }
    }
    if (cargo == null && abono == null) {
      errors.push(`Fila ${i + 1}: sin monto cargo ni abono (${description.slice(0, 40)})`);
    }
  }

  return { source_file: sourceFile, movements, errors };
}
