import fs from "node:fs";
import path from "node:path";

/** Semicolon CSV + es-CL number parsing (aligned with `scripts/cfraser-csv.ts`). */
export function numCsv(v: unknown): number | null {
  if (v == null) return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  const s = String(v).trim();
  if (!s) return null;
  const neg = s.includes("(") && s.includes(")");
  // Strip $, whitespace, UF label, NBSP / narrow NBSP / figure space (Numbers exports).
  const t = s
    .replace(/^\ufeff/, "")
    .replace(/US\$/gi, "")
    .replace(/[$\sUF\u00a0\u202f\u2007]/gi, "")
    .replace(/\./g, "")
    .replace(/,/g, ".")
    .replace(/[()]/g, "");
  const n = Number(t);
  if (!Number.isFinite(n)) return null;
  return neg ? -n : n;
}

export function readSemicolonCsv(filePath: string): string[][] {
  if (!fs.existsSync(filePath)) return [];
  const text = fs.readFileSync(filePath, "utf8");
  const lines = text.split(/\r?\n/);
  return lines.map((line) => line.split(";"));
}

/** One payment / capital row from Numbers export `depto-dividendos.csv` (sheet “dividendos”). */
export type DeptoDividendosPaymentRow = {
  cuota: string;
  occurred_on: string;
  amount_clp: number;
  amount_uf: number | null;
  uf_clp_day: number | null;
  credito_restante_uf: number | null;
  valor_neto_uf: number | null;
  valor_neto_clp: number | null;
  pagado_neto_uf: number | null;
  pago_acumulado_clp: number | null;
  /** Escenario “min UF” (hoja) — referencia antes del dividendo real del banco. */
  min_uf: number | null;
  amortizacion_clp: number | null;
  amortizacion_uf: number | null;
  amortizacion_ext_clp: number | null;
  amortizacion_ext_uf: number | null;
  interes_clp: number | null;
  interes_uf: number | null;
};

/** Fila para API / UI: movimiento + campos parseados de la nota. */
export type DeptoMortgageLedgerRow = {
  movement_id: number;
  occurred_on: string;
  amount_clp: number;
  cuota: string | null;
  amount_uf: number | null;
  uf_clp_day: number | null;
  credito_restante_uf: number | null;
  valor_neto_uf: number | null;
  valor_neto_clp: number | null;
  pagado_neto_uf: number | null;
  pago_acumulado_clp: number | null;
  min_uf: number | null;
  amortizacion_clp: number | null;
  amortizacion_uf: number | null;
  amortizacion_ext_clp: number | null;
  amortizacion_ext_uf: number | null;
  interes_clp: number | null;
  interes_uf: number | null;
};

const COL = {
  cuota: 0,
  fecha: 1,
  pago_clp: 2,
  pago_uf: 3,
  pct_dividendo: 4,
  uf_dia: 5,
  mm_pct: 6,
  yy_pct: 7,
  tasa_plus: 8,
  pago_clp_dup: 9,
  credito_restante_uf: 10,
  pct_credito_uf: 11,
  restante_clp: 12,
  pct_de_total: 13,
  delta_credito_clp: 14,
  valor_neto_uf: 15,
  valor_neto_clp: 16,
  pagado_neto_uf: 17,
  delta_valor_neto_clp: 18,
  valor_vivienda_uf: 19,
  valor_vivienda_clp: 20,
  min_uf: 24,
  incendio_clp: 46,
  incendio_uf: 47,
  desgravamen_clp: 48,
  desgravamen_uf: 49,
  total_seguros_uf: 50,
  total_seguros_clp: 51,
  amortizacion_clp: 52,
  amortizacion_uf: 53,
  amortizacion_ext_clp: 54,
  amortizacion_ext_uf: 55,
  interes_clp: 58,
  interes_uf: 59,
  delta_credito_amort_clp: 60,
  interes_oculto_clp: 61,
  interes_oculto_b_clp: 62,
  interes_real_clp: 63,
  interes_calculado_uf: 66,
  amort_interes_text: 67,
  pago_acumulado_clp: 72,
  amort_acum_clp: 73,
  interes_acum_clp: 74,
} as const;

function roundUf4(v: number): number {
  return Math.round(v * 1e4) / 1e4;
}

/** One row of the Numbers “dividendos” export (all numeric columns we use in the UI). */
export type DeptoMortgageSheetRow = {
  cuota: string;
  occurred_on: string;
  pago_clp: number;
  pago_uf: number | null;
  pct_dividendo: string | null;
  uf_clp_day: number | null;
  mm_pct: string | null;
  yy_pct: string | null;
  tasa_plus: number | null;
  credito_restante_uf: number | null;
  pct_credito_uf: string | null;
  restante_clp: number | null;
  pct_de_total: string | null;
  delta_credito_clp: number | null;
  valor_neto_uf: number | null;
  valor_neto_clp: number | null;
  pagado_neto_uf: number | null;
  delta_valor_neto_clp: number | null;
  valor_vivienda_uf: number | null;
  valor_vivienda_clp: number | null;
  min_uf: number | null;
  incendio_clp: number | null;
  incendio_uf: number | null;
  desgravamen_clp: number | null;
  desgravamen_uf: number | null;
  total_seguros_uf: number | null;
  total_seguros_clp: number | null;
  amortizacion_clp: number | null;
  amortizacion_uf: number | null;
  amortizacion_ext_clp: number | null;
  amortizacion_ext_uf: number | null;
  interes_clp: number | null;
  interes_uf: number | null;
  delta_credito_amort_clp: number | null;
  interes_oculto_clp: number | null;
  interes_oculto_b_clp: number | null;
  interes_real_clp: number | null;
  interes_calculado_uf: number | null;
  amort_interes_text: string | null;
  pago_acumulado_clp: number | null;
  amort_acum_clp: number | null;
  interes_acum_clp: number | null;
};

export type DeptoMortgageCsvMeta = {
  valor_vivienda_uf: number | null;
  hipoteca_tras_pie_uf: number | null;
  pie_clp: number | null;
  pie_uf: number | null;
  row_count: number;
  csv_path: string;
  /** Absolute path used when reading (debug / misconfigured CFRASER_CSV_DIR). */
  csv_absolute_path?: string;
  csv_file_exists?: boolean;
};

function strCell(row: string[], i: number): string | null {
  const s = String(row[i] ?? "").trim();
  return s || null;
}

function numAt(row: string[], i: number): number | null {
  if (i >= row.length) return null;
  return numCsv(row[i]);
}

function parseDividendosDataRow(row: string[]): DeptoMortgageSheetRow | null {
  if (!row || row.length < 22) return null;
  const occurred_on = String(row[COL.fecha] ?? "")
    .trim()
    .replace(/^\ufeff/, "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(occurred_on)) return null;
  const pago_clp = numCsv(row[COL.pago_clp]);
  if (pago_clp == null || !Number.isFinite(pago_clp) || pago_clp === 0) return null;
  const cuota = String(row[COL.cuota] ?? "").trim() || "—";
  const nUf = (v: number | null) => (v != null ? roundUf4(v) : null);
  return {
    cuota,
    occurred_on,
    pago_clp,
    pago_uf: nUf(numCsv(row[COL.pago_uf])),
    pct_dividendo: strCell(row, COL.pct_dividendo),
    uf_clp_day: numCsv(row[COL.uf_dia]),
    mm_pct: strCell(row, COL.mm_pct),
    yy_pct: strCell(row, COL.yy_pct),
    tasa_plus: numCsv(row[COL.tasa_plus]),
    credito_restante_uf: nUf(numCsv(row[COL.credito_restante_uf])),
    pct_credito_uf: strCell(row, COL.pct_credito_uf),
    restante_clp: numCsv(row[COL.restante_clp]),
    pct_de_total: strCell(row, COL.pct_de_total),
    delta_credito_clp: numCsv(row[COL.delta_credito_clp]),
    valor_neto_uf: nUf(numCsv(row[COL.valor_neto_uf])),
    valor_neto_clp: numCsv(row[COL.valor_neto_clp]),
    pagado_neto_uf: nUf(numCsv(row[COL.pagado_neto_uf])),
    delta_valor_neto_clp: numCsv(row[COL.delta_valor_neto_clp]),
    valor_vivienda_uf: nUf(numCsv(row[COL.valor_vivienda_uf])),
    valor_vivienda_clp: numCsv(row[COL.valor_vivienda_clp]),
    min_uf: nUf(numCsv(row[COL.min_uf])),
    incendio_clp: numCsv(row[COL.incendio_clp]),
    incendio_uf: nUf(numCsv(row[COL.incendio_uf])),
    desgravamen_clp: numCsv(row[COL.desgravamen_clp]),
    desgravamen_uf: nUf(numCsv(row[COL.desgravamen_uf])),
    total_seguros_uf: nUf(numCsv(row[COL.total_seguros_uf])),
    total_seguros_clp: numCsv(row[COL.total_seguros_clp]),
    amortizacion_clp: numCsv(row[COL.amortizacion_clp]),
    amortizacion_uf: nUf(numCsv(row[COL.amortizacion_uf])),
    amortizacion_ext_clp: numCsv(row[COL.amortizacion_ext_clp]),
    amortizacion_ext_uf: nUf(numCsv(row[COL.amortizacion_ext_uf])),
    interes_clp: numCsv(row[COL.interes_clp]),
    interes_uf: nUf(numCsv(row[COL.interes_uf])),
    delta_credito_amort_clp: numCsv(row[COL.delta_credito_amort_clp]),
    interes_oculto_clp: numCsv(row[COL.interes_oculto_clp]),
    interes_oculto_b_clp: numCsv(row[COL.interes_oculto_b_clp]),
    interes_real_clp: numCsv(row[COL.interes_real_clp]),
    interes_calculado_uf: nUf(numCsv(row[COL.interes_calculado_uf])),
    amort_interes_text: strCell(row, COL.amort_interes_text),
    pago_acumulado_clp: numAt(row, COL.pago_acumulado_clp),
    amort_acum_clp: numAt(row, COL.amort_acum_clp),
    interes_acum_clp: numAt(row, COL.interes_acum_clp),
  };
}

function sheetRowToPaymentRow(s: DeptoMortgageSheetRow): DeptoDividendosPaymentRow {
  return {
    cuota: s.cuota,
    occurred_on: s.occurred_on,
    amount_clp: s.pago_clp,
    amount_uf: s.pago_uf,
    uf_clp_day: s.uf_clp_day,
    credito_restante_uf: s.credito_restante_uf,
    valor_neto_uf: s.valor_neto_uf,
    valor_neto_clp: s.valor_neto_clp,
    pagado_neto_uf: s.pagado_neto_uf,
    pago_acumulado_clp: s.pago_acumulado_clp,
    min_uf: s.min_uf,
    amortizacion_clp: s.amortizacion_clp,
    amortizacion_uf: s.amortizacion_uf,
    amortizacion_ext_clp: s.amortizacion_ext_clp,
    amortizacion_ext_uf: s.amortizacion_ext_uf,
    interes_clp: s.interes_clp,
    interes_uf: s.interes_uf,
  };
}

/** Full “dividendos” sheet (one row per bank transfer / pie). Source for account UI. */
export function loadDeptoDividendosSheetLedger(cfraserDir: string): DeptoMortgageSheetRow[] {
  const fp = path.join(cfraserDir, "depto-dividendos.csv");
  const rows = readSemicolonCsv(fp);
  const out: DeptoMortgageSheetRow[] = [];
  for (let i = 3; i < rows.length; i++) {
    const parsed = parseDividendosDataRow(rows[i] ?? []);
    if (parsed) out.push(parsed);
  }
  return out;
}

export function mortgageMetaFromSheetRows(rows: DeptoMortgageSheetRow[], csvPath: string): DeptoMortgageCsvMeta {
  const pie = rows.find((r) => r.cuota.toLowerCase() === "pie");
  return {
    valor_vivienda_uf: pie?.valor_vivienda_uf ?? rows[0]?.valor_vivienda_uf ?? null,
    hipoteca_tras_pie_uf: pie?.credito_restante_uf ?? null,
    pie_clp: pie?.pago_clp ?? null,
    pie_uf: pie?.pago_uf ?? null,
    row_count: rows.length,
    csv_path: csvPath,
  };
}

/** Rows for `import:excel` property movements (subset of the sheet). */
export function loadDeptoDividendosPaymentRows(cfraserDir: string): DeptoDividendosPaymentRow[] {
  return loadDeptoDividendosSheetLedger(cfraserDir).map(sheetRowToPaymentRow);
}

export function buildDeptoDividendosMovementNote(r: DeptoDividendosPaymentRow): string {
  const parts = [
    "import:excel|depto-dividendos",
    `cuota=${encodeURIComponent(r.cuota)}`,
    r.amount_uf != null ? `uf=${r.amount_uf}` : null,
    r.uf_clp_day != null ? `ufdia=${Math.round(r.uf_clp_day * 100) / 100}` : null,
    r.credito_restante_uf != null ? `cruf=${r.credito_restante_uf}` : null,
    r.valor_neto_uf != null ? `vnuf=${r.valor_neto_uf}` : null,
    r.valor_neto_clp != null ? `vnclp=${Math.round(r.valor_neto_clp)}` : null,
    r.pagado_neto_uf != null ? `pnuf=${r.pagado_neto_uf}` : null,
    r.pago_acumulado_clp != null ? `paclp=${Math.round(r.pago_acumulado_clp)}` : null,
    r.min_uf != null ? `minuf=${r.min_uf}` : null,
    r.amortizacion_clp != null ? `amclp=${Math.round(r.amortizacion_clp)}` : null,
    r.amortizacion_uf != null ? `amuf=${r.amortizacion_uf}` : null,
    r.amortizacion_ext_clp != null ? `axclp=${Math.round(r.amortizacion_ext_clp)}` : null,
    r.amortizacion_ext_uf != null ? `axuf=${r.amortizacion_ext_uf}` : null,
    r.interes_clp != null ? `iclp=${Math.round(r.interes_clp)}` : null,
    r.interes_uf != null ? `iuf=${r.interes_uf}` : null,
  ].filter(Boolean) as string[];
  return parts.join("|");
}

export function parseDeptoDividendosMovementNote(note: string | null): Partial<DeptoDividendosPaymentRow> & {
  cuota?: string;
} | null {
  if (!note || !note.startsWith("import:excel|depto-dividendos")) return null;
  const out: Record<string, string> = {};
  for (const seg of note.split("|").slice(1)) {
    const eq = seg.indexOf("=");
    if (eq <= 0) continue;
    const k = seg.slice(0, eq);
    const v = seg.slice(eq + 1);
    out[k] = v;
  }
  const num = (k: string) => {
    const s = out[k];
    if (s == null || s === "") return null;
    return Number(s);
  };
  return {
    cuota: out.cuota != null ? decodeURIComponent(out.cuota) : undefined,
    amount_uf: num("uf"),
    uf_clp_day: num("ufdia"),
    credito_restante_uf: num("cruf"),
    valor_neto_uf: num("vnuf"),
    valor_neto_clp: num("vnclp"),
    pagado_neto_uf: num("pnuf"),
    pago_acumulado_clp: num("paclp"),
    min_uf: num("minuf"),
    amortizacion_clp: num("amclp"),
    amortizacion_uf: num("amuf"),
    amortizacion_ext_clp: num("axclp"),
    amortizacion_ext_uf: num("axuf"),
    interes_clp: num("iclp"),
    interes_uf: num("iuf"),
  };
}

const NOTE_PREFIX = "import:excel|depto-dividendos";

export function mortgageLedgerRowsFromDbRows(
  rows: { id: number; amount_clp: number; occurred_on: string; note: string | null }[]
): DeptoMortgageLedgerRow[] {
  const out: DeptoMortgageLedgerRow[] = [];
  for (const r of rows) {
    if (!r.note?.startsWith(NOTE_PREFIX)) continue;
    const p = parseDeptoDividendosMovementNote(r.note);
    if (!p) continue;
    out.push({
      movement_id: r.id,
      occurred_on: r.occurred_on,
      amount_clp: r.amount_clp,
      cuota: p.cuota ?? null,
      amount_uf: p.amount_uf ?? null,
      uf_clp_day: p.uf_clp_day ?? null,
      credito_restante_uf: p.credito_restante_uf ?? null,
      valor_neto_uf: p.valor_neto_uf ?? null,
      valor_neto_clp: p.valor_neto_clp ?? null,
      pagado_neto_uf: p.pagado_neto_uf ?? null,
      pago_acumulado_clp: p.pago_acumulado_clp ?? null,
      min_uf: p.min_uf ?? null,
      amortizacion_clp: p.amortizacion_clp ?? null,
      amortizacion_uf: p.amortizacion_uf ?? null,
      amortizacion_ext_clp: p.amortizacion_ext_clp ?? null,
      amortizacion_ext_uf: p.amortizacion_ext_uf ?? null,
      interes_clp: p.interes_clp ?? null,
      interes_uf: p.interes_uf ?? null,
    });
  }
  return out;
}
