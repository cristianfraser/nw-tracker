/**
 * The summary of a declaración jurada third parties filed about the taxpayer, from the xlsx the
 * SII's «Información de sus ingresos, agentes retenedores y otros» page downloads
 * (`DJ_<code>_<año tributario>_<rut>.xlsx`): a few header rows over one row of values. The file
 * carries no merged-cell ranges, so a header written once over several columns is carried
 * rightward in every header row but the lowest (whose blanks are real blanks); a column's field
 * is its column letter plus its header path, the letter keeping repeated titles apart (the DJ
 * 1964 sheet prints «MONTO» for every section). Values stay as printed (Chilean format).
 *
 * The same summary also comes as the page itself («Información para declarar», saved from the
 * browser): one `<table id="<dj code>">` per DJ whose rows are header rows (`table-agente-th`,
 * cells with colspan / rowspan) over one data row (`table-agente-td`) — read into the same grid,
 * a spanning header filling every cell it covers.
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

/**
 * Every field under the header `section` (one segment of the header path, not its last), with its
 * amount: a DJ that splits one figure over several columns (DJ 1922 prints the distributions
 * afectas al IGC in four, by the credit they carry, and words some of them differently from year
 * to year). Throws when no field is under it.
 */
export function informedDjSectionAmounts(
  fields: readonly InformedDjField[],
  section: string
): { field: string; amount: number }[] {
  const hits = fields.filter((f) => {
    const path = f.field.slice(f.field.indexOf(": ") + 2).split(" / ");
    return path.slice(0, -1).includes(section);
  });
  if (hits.length === 0) throw new Error(`DJ summary: no field under «${section}»`);
  return hits.map((f) => ({ field: f.field, amount: parseChileanNumber(f.value) }));
}

function htmlText(raw: string): string {
  return raw
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCharCode(Number(n)))
    .replace(/\s+/g, " ")
    .trim();
}

/** Every `<table id="<digits>">` of the SII's «Información para declarar» page, as DJ fields. */
export function parseInformedDjHtml(html: string): Map<number, InformedDjField[]> {
  const out = new Map<number, InformedDjField[]>();
  for (const t of html.matchAll(/<table\b[^>]*\bid="(\d+)"[^>]*>([\s\S]*?)<\/table>/g)) {
    const djCode = Number(t[1]);
    const rows: { header: boolean; cells: { text: string; colspan: number; rowspan: number }[] }[] = [];
    for (const tr of t[2]!.matchAll(/<tr\b([^>]*)>([\s\S]*?)<\/tr>/g)) {
      // The class attribute says which kind of row it is (ng-class names both, so it cannot be used).
      const cls = /\sclass="([^"]*)"/.exec(tr[1]!)?.[1] ?? "";
      const header = /\btable-agente-th\b/.test(cls);
      if (!header && !/\btable-agente-td\b/.test(cls)) throw new Error(`DJ ${djCode}: a row that is neither header nor data`);
      const cells = [...tr[2]!.matchAll(/<td\b([^>]*)>([\s\S]*?)<\/td>/g)].map((c) => ({
        text: htmlText(c[2]!),
        colspan: Number(/colspan="(\d+)"/.exec(c[1]!)?.[1] ?? 1),
        rowspan: Number(/rowspan="(\d+)"/.exec(c[1]!)?.[1] ?? 1),
      }));
      rows.push({ header, cells });
    }
    const data = rows.filter((r) => !r.header);
    if (data.length === 0) continue; // a DJ with nothing informed
    if (data.length > 1) throw new Error(`DJ ${djCode}: ${data.length} data rows, expected 1`);
    // Lay the header rows onto a grid, honouring the spans.
    const grid: string[][] = [];
    const headerRows = rows.filter((r) => r.header);
    headerRows.forEach((r, ri) => {
      grid[ri] ??= [];
      let col = 0;
      for (const c of r.cells) {
        while (grid[ri]![col] !== undefined) col++;
        for (let dr = 0; dr < c.rowspan; dr++) {
          grid[ri + dr] ??= [];
          for (let dc = 0; dc < c.colspan; dc++) grid[ri + dr]![col + dc] = c.text;
        }
        col += c.colspan;
      }
    });
    const values = data[0]!.cells;
    const width = values.reduce((s, c) => s + c.colspan, 0);
    const fields: InformedDjField[] = [];
    let col = 0;
    for (const v of values) {
      const path: string[] = [];
      for (const r of grid) {
        const h = r?.[col];
        if (h && path[path.length - 1] !== h) path.push(h);
      }
      if (path.length === 0) throw new Error(`DJ ${djCode}: column ${col + 1} of ${width} has a value but no header`);
      fields.push({ field: `${XLSX.utils.encode_col(col)}: ${path.join(" / ")}`, value: v.text });
      col += v.colspan;
    }
    if (out.has(djCode)) throw new Error(`DJ ${djCode} appears twice on the page`);
    out.set(djCode, fields);
  }
  return out;
}
