/**
 * The summary of a declaración jurada third parties filed about the taxpayer, from the xlsx the
 * SII's «Información de sus ingresos, agentes retenedores y otros» page downloads
 * (`DJ_<code>_<año tributario>_<rut>.xlsx`): a few header rows over one row of values. The file
 * carries no merged-cell ranges, so a header written once over several columns is carried
 * rightward in every header row but the lowest (whose blanks are real blanks); a column's field
 * is its column letter plus its header path, the letter keeping repeated titles apart (the DJ
 * 1964 sheet prints «MONTO» for every section). Values stay as printed (Chilean format).
 */
import XLSX from "xlsx";
import { parseChileanNumber } from "./chileanNumber.js";

export type InformedDjField = { field: string; value: string };

export function parseInformedDjSheet(rows: readonly (readonly unknown[])[]): InformedDjField[] {
  const nonEmpty = rows.filter((r) => r.some((c) => String(c ?? "").trim() !== ""));
  if (nonEmpty.length < 2) throw new Error("DJ summary: expected header rows and a value row");
  const values = nonEmpty[nonEmpty.length - 1]!;
  const headers = nonEmpty.slice(0, -1).map((r, i, all) => {
    const cells = values.map((_, c) => String(r[c] ?? "").trim());
    if (i === all.length - 1) return cells;
    let carry = "";
    return cells.map((c) => (c ? (carry = c) : carry));
  });
  return values.map((v, c) => {
    const path = headers.map((h) => h[c]).filter(Boolean).join(" / ");
    const value = String(v ?? "").trim();
    if (!path) throw new Error(`DJ summary: column ${XLSX.utils.encode_col(c)} has a value but no header`);
    return { field: `${XLSX.utils.encode_col(c)}: ${path}`, value };
  });
}

export function parseInformedDjXlsx(buffer: Buffer): InformedDjField[] {
  const wb = XLSX.read(buffer);
  if (wb.SheetNames.length !== 1) throw new Error(`DJ summary: ${wb.SheetNames.length} sheets, expected 1`);
  const ws = wb.Sheets[wb.SheetNames[0]!]!;
  return parseInformedDjSheet(XLSX.utils.sheet_to_json(ws, { header: 1, raw: false, defval: "" }) as unknown[][]);
}

/** File name → DJ code and año tributario. */
export function informedDjFileKey(fileName: string): { djCode: number; taxYear: number } | null {
  const m = /^DJ_(\d+)_(\d{4})_[\dkK.\-]+\.xlsx$/.exec(fileName);
  return m ? { djCode: Number(m[1]), taxYear: Number(m[2]) } : null;
}

/** The one field whose header path ends with `label` (and, if given, is in `column`). */
export function informedDjAmount(
  fields: readonly InformedDjField[],
  label: string,
  column?: string
): number {
  const hits = fields.filter(
    (f) =>
      (f.field.endsWith(` / ${label}`) || f.field.endsWith(`: ${label}`)) &&
      (column == null || f.field.startsWith(`${column}:`))
  );
  if (hits.length !== 1) throw new Error(`DJ summary: ${hits.length} fields match «${label}»${column ? ` in ${column}` : ""}`);
  return parseChileanNumber(hits[0]!.value);
}
