import fs from "node:fs";
import path from "node:path";
import { resolveCfraserCsvDir } from "./cfraserPaths.js";
import {
  loadDeptoDividendosSheetRowsRawFromDb,
  replaceDeptoDividendosSheetRowsInDb,
} from "./deptoSheetDb.js";
import { ufRowOnOrBefore } from "./fxRates.js";

/** Semicolon CSV + es-CL number parsing (aligned with `cfraserCsv.ts`). */
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
  incendio_clp: number | null;
  desgravamen_clp: number | null;
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

/** UF amounts in payment breakdown (amort, interés, pago) — 5 decimals in the sheet. */
function roundUf5(v: number): number {
  return Math.round(v * 1e5) / 1e5;
}

/** Depto Suecia — shared account label (Table 2-1 / product). Gross UF is data-derived (vnuf + cruf). */
export const DEPTO_SUECIA_ACCOUNT_DISPLAY_NAME = "suecia";

/** Repayment term labels on row 2 of `depto-dividendos.csv` (years). */
export const DEPTO_PAYMENT_SCENARIO_TERMS = [30, 25, 20, 15, 12, 10, 5] as const;
export type DeptoPaymentScenarioTerm = (typeof DEPTO_PAYMENT_SCENARIO_TERMS)[number] | "max";

export type DeptoPaymentScenarioCell = {
  term: DeptoPaymentScenarioTerm;
  payment_uf: number | null;
  payment_clp: number | null;
};

/** Reference row: min/max UF payment scenarios (not a movement). */
export type DeptoPaymentScenarioRow = {
  /** Schedule date (day 11 of month), not the bank payment date. */
  occurred_on: string;
  cuota: string;
  /** 30-year amortization (min payment) — updatable in the sheet. */
  min_payment_uf: number | null;
  min_payment_clp: number | null;
  scenarios: DeptoPaymentScenarioCell[];
  /** Projected upcoming installment (first row in the UI). */
  is_next_payment?: boolean;
};

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
  const nUfBal = (v: number | null) => (v != null ? roundUf4(v) : null);
  const nUf5 = (v: number | null) => (v != null ? roundUf5(v) : null);
  return {
    cuota,
    occurred_on,
    pago_clp,
    pago_uf: nUf5(numCsv(row[COL.pago_uf])),
    pct_dividendo: strCell(row, COL.pct_dividendo),
    uf_clp_day: numCsv(row[COL.uf_dia]),
    mm_pct: strCell(row, COL.mm_pct),
    yy_pct: strCell(row, COL.yy_pct),
    tasa_plus: numCsv(row[COL.tasa_plus]),
    credito_restante_uf: nUfBal(numCsv(row[COL.credito_restante_uf])),
    pct_credito_uf: strCell(row, COL.pct_credito_uf),
    restante_clp: numCsv(row[COL.restante_clp]),
    pct_de_total: strCell(row, COL.pct_de_total),
    delta_credito_clp: numCsv(row[COL.delta_credito_clp]),
    valor_neto_uf: nUfBal(numCsv(row[COL.valor_neto_uf])),
    valor_neto_clp: numCsv(row[COL.valor_neto_clp]),
    pagado_neto_uf: nUf5(numCsv(row[COL.pagado_neto_uf])),
    delta_valor_neto_clp: numCsv(row[COL.delta_valor_neto_clp]),
    valor_vivienda_uf: nUfBal(numCsv(row[COL.valor_vivienda_uf])),
    valor_vivienda_clp: numCsv(row[COL.valor_vivienda_clp]),
    min_uf: nUf5(numCsv(row[COL.min_uf])),
    incendio_clp: numCsv(row[COL.incendio_clp]),
    incendio_uf: nUf5(numCsv(row[COL.incendio_uf])),
    desgravamen_clp: numCsv(row[COL.desgravamen_clp]),
    desgravamen_uf: nUf5(numCsv(row[COL.desgravamen_uf])),
    total_seguros_uf: nUf5(numCsv(row[COL.total_seguros_uf])),
    total_seguros_clp: numCsv(row[COL.total_seguros_clp]),
    amortizacion_clp: numCsv(row[COL.amortizacion_clp]),
    amortizacion_uf: nUf5(numCsv(row[COL.amortizacion_uf])),
    amortizacion_ext_clp: numCsv(row[COL.amortizacion_ext_clp]),
    amortizacion_ext_uf: nUf5(numCsv(row[COL.amortizacion_ext_uf])),
    interes_clp: numCsv(row[COL.interes_clp]),
    interes_uf: nUf5(numCsv(row[COL.interes_uf])),
    delta_credito_amort_clp: numCsv(row[COL.delta_credito_amort_clp]),
    interes_oculto_clp: numCsv(row[COL.interes_oculto_clp]),
    interes_oculto_b_clp: numCsv(row[COL.interes_oculto_b_clp]),
    interes_real_clp: numCsv(row[COL.interes_real_clp]),
    interes_calculado_uf: nUf5(numCsv(row[COL.interes_calculado_uf])),
    amort_interes_text: strCell(row, COL.amort_interes_text),
    pago_acumulado_clp: numAt(row, COL.pago_acumulado_clp),
    amort_acum_clp: numAt(row, COL.amort_acum_clp),
    interes_acum_clp: numAt(row, COL.interes_acum_clp),
  };
}

export function sheetRowToPaymentRow(s: DeptoMortgageSheetRow): DeptoDividendosPaymentRow {
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
    incendio_clp: s.incendio_clp,
    desgravamen_clp: s.desgravamen_clp,
  };
}

/** Full “dividendos” sheet (one row per bank transfer / pie). Source for account UI. */
/** Align month-end snapshot labels with dividendos payment dates (see valuation chart cutoffs). */
function snapshotDepositCutoff(asOfLabel: string): string {
  const m = /^(\d{4})-(\d{2})-01$/.exec(asOfLabel);
  if (!m) return asOfLabel;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  if (!Number.isFinite(y) || mo < 1 || mo > 12) return asOfLabel;
  return new Date(Date.UTC(y, mo, 0)).toISOString().slice(0, 10);
}

function deptoNumericFieldBySnapshotDates(
  dateStrsAsc: readonly string[],
  ledger: readonly DeptoMortgageSheetRow[],
  read: (row: DeptoMortgageSheetRow) => number | null
): Map<string, number> {
  const out = new Map<string, number>();
  if (dateStrsAsc.length === 0 || ledger.length === 0) return out;
  const sorted = [...ledger].sort((a, b) => {
    const c = a.occurred_on.localeCompare(b.occurred_on);
    return c !== 0 ? c : a.cuota.localeCompare(b.cuota);
  });
  let j = 0;
  let last: number | null = null;
  for (const d of dateStrsAsc) {
    const cut = snapshotDepositCutoff(d);
    while (j < sorted.length && sorted[j]!.occurred_on <= cut) {
      const v = read(sorted[j]!);
      if (v != null && Number.isFinite(v)) last = v;
      j++;
    }
    if (last != null) out.set(d, last);
  }
  return out;
}

/**
 * Forward-filled **crédito restante (UF)** from the depto dividendos sheet at each snapshot date.
 * Used for mortgage month-end detail (`Saldo UF` column; CLP cierre = UF × UF día).
 *
 * Prepago rows carry unreliable `credito_restante_uf` in the Numbers export (balance can rise vs the
 * prior cuota). Month-end marks use the last **cuota** row on or before the snapshot; prepagos still
 * count in CLP capital flow via {@link deptoPropertyClpPaymentsThroughDate}.
 */
export function deptoCreditoRestanteUfBySnapshotDates(
  dateStrsAsc: readonly string[],
  ledger: readonly DeptoMortgageSheetRow[]
): Map<string, number> {
  const out = new Map<string, number>();
  if (dateStrsAsc.length === 0 || ledger.length === 0) return out;
  const sorted = [...ledger].sort((a, b) => {
    const c = a.occurred_on.localeCompare(b.occurred_on);
    return c !== 0 ? c : a.cuota.localeCompare(b.cuota);
  });
  let j = 0;
  let last: number | null = null;
  for (const d of dateStrsAsc) {
    const cut = snapshotDepositCutoff(d);
    while (j < sorted.length && sorted[j]!.occurred_on <= cut) {
      const row = sorted[j]!;
      if (!isDeptoPrepagoCuota(row.cuota)) {
        const v = row.credito_restante_uf;
        if (v != null && Number.isFinite(v)) last = v;
      }
      j++;
    }
    if (last != null) out.set(d, last);
  }
  return out;
}

/**
 * Mortgage balance in CLP at each snapshot: **crédito restante (UF) × UF** (`uf_daily`), rounded to whole pesos.
 * `ufClpByDate` must come from {@link ufClpBySnapshotDatesAsc} in `fxRates.ts` (not the dividendos sheet).
 */
export function deptoMortgageCloseClpBySnapshotDates(
  dateStrsAsc: readonly string[],
  ledger: readonly DeptoMortgageSheetRow[],
  ufClpByDate: Map<string, number>
): Map<string, number> {
  const firstOwn = firstDeptoPropertyOwnershipYmd(ledger);
  const ufByDate = deptoMortgageBalanceUfBySnapshotDates(dateStrsAsc, ledger);
  const out = new Map<string, number>();
  for (const d of dateStrsAsc) {
    if (firstOwn != null && d < firstOwn) continue;
    const uf = ufByDate.get(d);
    const ufClp = ufClpByDate.get(d);
    if (uf != null && ufClp != null && Number.isFinite(uf) && Number.isFinite(ufClp)) {
      out.set(d, Math.round(uf * ufClp));
    }
  }
  return out;
}

/** Forward-filled crédito restante (UF) from the full dividendos ledger (incl. pie). */
export function deptoMortgageBalanceUfBySnapshotDates(
  dateStrsAsc: readonly string[],
  ledger: readonly DeptoMortgageSheetRow[]
): Map<string, number> {
  return deptoCreditoRestanteUfBySnapshotDates(dateStrsAsc, ledger);
}

/** Mortgage balance in CLP: crédito restante (UF) × UF día (`uf_daily`). */
export function deptoMortgageBalanceClpBySnapshotDates(
  dateStrsAsc: readonly string[],
  ledger: readonly DeptoMortgageSheetRow[],
  ufClpByDate: Map<string, number>
): Map<string, number> {
  const ufByDate = deptoMortgageBalanceUfBySnapshotDates(dateStrsAsc, ledger);
  const out = new Map<string, number>();
  for (const d of dateStrsAsc) {
    const uf = ufByDate.get(d);
    const ufClp = ufClpByDate.get(d);
    if (uf != null && ufClp != null && Number.isFinite(uf) && Number.isFinite(ufClp)) {
      out.set(d, Math.round(uf * ufClp));
    }
  }
  return out;
}

export type DeptoAccountMarkAtYmd = { value_clp: number; as_of_date: string };

/**
 * Net equity UF: forward-filled **valor neto (UF)** from the ledger rows (only on/after
 * pie / compra). Prepago rows are skipped like the balance fill — their vnuf is as
 * unreliable as their cruf in the Numbers export. Data-derived (vnuf ≡ gross − balance
 * per row), so it works for any property, not just the 5400-UF Suecia sheet.
 */
export function deptoSueciaNetEquityUfBySnapshotDates(
  dateStrsAsc: readonly string[],
  ledger: readonly DeptoMortgageSheetRow[]
): Map<string, number> {
  const firstOwn = firstDeptoPropertyOwnershipYmd(ledger);
  const out = new Map<string, number>();
  if (dateStrsAsc.length === 0 || ledger.length === 0) return out;
  const sorted = [...ledger].sort((a, b) => {
    const c = a.occurred_on.localeCompare(b.occurred_on);
    return c !== 0 ? c : a.cuota.localeCompare(b.cuota);
  });
  let j = 0;
  let last: number | null = null;
  for (const d of dateStrsAsc) {
    const cut = snapshotDepositCutoff(d);
    while (j < sorted.length && sorted[j]!.occurred_on <= cut) {
      const row = sorted[j]!;
      if (!isDeptoPrepagoCuota(row.cuota)) {
        const v = row.valor_neto_uf;
        if (v != null && Number.isFinite(v)) last = v;
      }
      j++;
    }
    if (firstOwn != null && d < firstOwn) continue;
    if (last != null) out.set(d, roundUf4(Math.max(0, last)));
  }
  return out;
}

/** Property month-end close CLP: net equity UF × UF día (`uf_daily`). */
export function deptoSueciaPropertyCloseClpBySnapshotDates(
  dateStrsAsc: readonly string[],
  ledger: readonly DeptoMortgageSheetRow[],
  ufClpByDate: Map<string, number>
): Map<string, number> {
  const netUf = deptoSueciaNetEquityUfBySnapshotDates(dateStrsAsc, ledger);
  const out = new Map<string, number>();
  for (const d of dateStrsAsc) {
    const uf = netUf.get(d);
    const ufClp = ufClpByDate.get(d);
    if (uf != null && ufClp != null && Number.isFinite(uf) && Number.isFinite(ufClp)) {
      out.set(d, Math.round(uf * ufClp));
    }
  }
  return out;
}

const DEPTO_TABLE11_CSV = "depto-Table 1-1.csv";

/** Undated prepago rows from Numbers “Table 1-1” (e.g. `prepago parcial`). */
export type DeptoTable11Prepayment = {
  cuota: string;
  pago_clp: number;
  pago_uf: number | null;
};

function parseTable11PrepaymentRow(row: string[]): DeptoTable11Prepayment | null {
  const cuota = String(row[0] ?? "")
    .trim()
    .replace(/^\ufeff/, "");
  if (!cuota || !/^prepago/i.test(cuota)) return null;
  if (/^prepago\s+total$/i.test(cuota)) return null;
  /** Summary row on Table 1-1 — not a dated payment (do not merge into dividendos). */
  if (/^prepago\s+parcial$/i.test(cuota)) return null;
  const pago_clp = numCsv(row[2]);
  if (pago_clp == null || !Number.isFinite(pago_clp) || Math.abs(pago_clp) < 1) return null;
  return { cuota, pago_clp: Math.abs(pago_clp), pago_uf: numCsv(row[1]) };
}

/** Prepayments listed on Table 1-1 but missing from `depto-dividendos.csv`. */
export function loadDeptoTable11SupplementalPrepayments(cfraserDir: string): DeptoTable11Prepayment[] {
  const fp = path.join(cfraserDir, DEPTO_TABLE11_CSV);
  const rows = readSemicolonCsv(fp);
  const out: DeptoTable11Prepayment[] = [];
  for (const row of rows) {
    const p = parseTable11PrepaymentRow(row);
    if (p) out.push(p);
  }
  return out;
}

/** Month where sheet payments do not explain the CLP balance drop (typical prepago month). */
function inferSupplementalMonthFromBalanceGap(
  main: readonly DeptoMortgageSheetRow[],
  afterYm: string
): string | null {
  const byMonth = new Map<string, DeptoMortgageSheetRow>();
  for (const r of main) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(r.occurred_on)) continue;
    const ym = r.occurred_on.slice(0, 7);
    const prev = byMonth.get(ym);
    if (!prev || r.occurred_on >= prev.occurred_on) byMonth.set(ym, r);
  }
  const months = [...byMonth.keys()].sort();
  let bestYm: string | null = null;
  let bestGap = 0;
  for (let i = 1; i < months.length; i++) {
    const ym = months[i]!;
    if (ym <= afterYm) continue;
    if (main.some((p) => /^prepago/i.test(p.cuota) && p.occurred_on.startsWith(ym))) continue;
    const prior = byMonth.get(months[i - 1]!)?.restante_clp;
    const close = byMonth.get(ym)?.restante_clp;
    if (prior == null || close == null) continue;
    const payments = main
      .filter((r) => r.occurred_on.startsWith(ym) && isDeptoMortgagePaymentCuota(r.cuota))
      .reduce((s, r) => s + Math.abs(r.pago_clp), 0);
    const gap = prior - close - payments;
    if (gap > bestGap && gap > 1_000_000) {
      bestGap = gap;
      bestYm = ym;
    }
  }
  return bestYm;
}

/** Assign undated supplementals from Table 1-1 to months missing a prepago row in the main sheet. */
function supplementalPrepaymentDatesByCuota(
  supplementals: readonly DeptoTable11Prepayment[],
  main: readonly DeptoMortgageSheetRow[]
): Map<string, string> {
  const mainLabels = new Set(main.map((r) => r.cuota.toLowerCase().trim()));
  const missing = supplementals.filter((s) => !mainLabels.has(s.cuota.toLowerCase().trim()));
  const out = new Map<string, string>();
  if (missing.length === 0) return out;

  const lastPrepago = main
    .filter((r) => /^prepago/i.test(r.cuota) && /^\d{4}-\d{2}-\d{2}$/.test(r.occurred_on))
    .sort((a, b) => a.occurred_on.localeCompare(b.occurred_on))
    .at(-1);
  const afterYm = lastPrepago?.occurred_on.slice(0, 7) ?? "0000-00";

  if (missing.length === 1) {
    const ym = inferSupplementalMonthFromBalanceGap(main, afterYm);
    if (ym) out.set(missing[0]!.cuota.toLowerCase().trim(), `${ym}-10`);
    return out;
  }

  const gapMonths: string[] = [];
  const seenYm = new Set<string>();
  for (const r of [...main].sort((a, b) => a.occurred_on.localeCompare(b.occurred_on))) {
    const ym = r.occurred_on.slice(0, 7);
    if (ym <= afterYm) continue;
    if (seenYm.has(ym)) continue;
    if (/^prepago/i.test(r.cuota)) continue;
    if (!isDeptoMortgagePaymentCuota(r.cuota)) continue;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(r.occurred_on)) continue;
    if (main.some((p) => /^prepago/i.test(p.cuota) && p.occurred_on.startsWith(ym))) continue;
    seenYm.add(ym);
    gapMonths.push(ym);
  }
  const assignFromEnd = gapMonths.slice(-missing.length);
  for (let i = 0; i < missing.length; i++) {
    const ym =
      assignFromEnd[i] ??
      [...main]
        .filter((r) => /^\d{4}-\d{2}-\d{2}$/.test(r.occurred_on))
        .at(-1)!
        .occurred_on.slice(0, 7);
    out.set(missing[i]!.cuota.toLowerCase().trim(), `${ym}-10`);
  }
  return out;
}

function buildSyntheticPrepaymentRow(p: DeptoTable11Prepayment, occurred_on: string): DeptoMortgageSheetRow {
  return {
    cuota: p.cuota,
    occurred_on,
    pago_clp: p.pago_clp,
    pago_uf: p.pago_uf != null ? roundUf5(p.pago_uf) : null,
    pct_dividendo: null,
    uf_clp_day: null,
    mm_pct: null,
    yy_pct: null,
    tasa_plus: null,
    credito_restante_uf: null,
    pct_credito_uf: null,
    restante_clp: null,
    pct_de_total: null,
    delta_credito_clp: null,
    valor_neto_uf: null,
    valor_neto_clp: null,
    pagado_neto_uf: null,
    delta_valor_neto_clp: null,
    valor_vivienda_uf: null,
    valor_vivienda_clp: null,
    min_uf: null,
    incendio_clp: null,
    incendio_uf: null,
    desgravamen_clp: null,
    desgravamen_uf: null,
    total_seguros_uf: null,
    total_seguros_clp: null,
    amortizacion_clp: null,
    amortizacion_uf: null,
    amortizacion_ext_clp: null,
    amortizacion_ext_uf: null,
    interes_clp: null,
    interes_uf: null,
    delta_credito_amort_clp: null,
    interes_oculto_clp: null,
    interes_oculto_b_clp: null,
    interes_real_clp: null,
    interes_calculado_uf: null,
    amort_interes_text: null,
    pago_acumulado_clp: null,
    amort_acum_clp: null,
    interes_acum_clp: null,
  };
}

function mergeSupplementalPrepaymentsIntoLedger(
  main: DeptoMortgageSheetRow[],
  cfraserDir: string
): DeptoMortgageSheetRow[] {
  const supplementals = loadDeptoTable11SupplementalPrepayments(cfraserDir);
  if (supplementals.length === 0) return main;

  const dates = supplementalPrepaymentDatesByCuota(supplementals, main);
  const merged = [...main];
  for (const p of supplementals) {
    const key = p.cuota.toLowerCase().trim();
    if (main.some((r) => r.cuota.toLowerCase().trim() === key)) continue;
    const occurred_on = dates.get(key);
    if (!occurred_on) continue;
    merged.push(buildSyntheticPrepaymentRow(p, occurred_on));
  }
  merged.sort((a, b) => {
    const c = a.occurred_on.localeCompare(b.occurred_on);
    return c !== 0 ? c : a.cuota.localeCompare(b.cuota);
  });
  return merged;
}

/** Import scripts only — parses `cfraser/depto-dividendos.csv` (+ Table 1-1 supplementals). */
export function loadDeptoDividendosSheetLedgerFromFile(cfraserDir: string): DeptoMortgageSheetRow[] {
  const fp = path.join(cfraserDir, "depto-dividendos.csv");
  const rows = readSemicolonCsv(fp);
  const out: DeptoMortgageSheetRow[] = [];
  for (let i = 3; i < rows.length; i++) {
    const parsed = parseDividendosDataRow(rows[i] ?? []);
    if (parsed) out.push(parsed);
  }
  return enrichDeptoRowsUfClpFromDb(mergeSupplementalPrepaymentsIntoLedger(out, cfraserDir));
}

/** @deprecated Import-only. Runtime uses `loadDeptoLedgerFromMovements`. */
export function loadDeptoDividendosSheetLedger(cfraserDir: string): DeptoMortgageSheetRow[] {
  return loadDeptoDividendosSheetLedgerFromFile(cfraserDir);
}

/**
 * @deprecated Import/manual WRITE paths and their tests only. Runtime reads use
 * `loadDeptoLedgerFromMovements()` (movements + uf_daily) — the sheet table is the
 * spreadsheet master mirror, never a request-path source.
 */
export function loadDeptoDividendosSheetLedgerFromDb(): DeptoMortgageSheetRow[] {
  return enrichDeptoRowsUfClpFromDb(loadDeptoDividendosSheetRowsRawFromDb());
}

export { replaceDeptoDividendosSheetRowsInDb };

/** Σ mortgage payments (cuotas + prepagos) in the calendar month of `asOf`, from the merged dividendos ledger. */
export function mortgageSheetPaymentsClpInMonth(
  ledger: readonly DeptoMortgageSheetRow[],
  asOf: string
): number {
  return mortgageSheetPaymentsClpThroughDate(ledger, asOf, null);
}

/**
 * Σ mortgage payments in the calendar month of `asOf` with `occurred_on` ≤ `asOf`.
 * When `afterExclusive` is set, only counts payments strictly after that date (same month snapshots).
 */
export function mortgageSheetPaymentsClpThroughDate(
  ledger: readonly DeptoMortgageSheetRow[],
  asOf: string,
  afterExclusive: string | null
): number {
  const mk = asOf.slice(0, 7);
  let sum = 0;
  for (const r of ledger) {
    if (!isDeptoMortgagePaymentCuota(r.cuota)) continue;
    if (r.occurred_on.slice(0, 7) !== mk) continue;
    if (afterExclusive != null && r.occurred_on <= afterExclusive) continue;
    if (r.occurred_on > asOf) continue;
    sum += Math.abs(r.pago_clp);
  }
  return sum;
}

/**
 * Property capital flow: actual CLP paid in the calendar month of `asOf` (pie, cuotas, prepagos).
 * P/L compares pesos out of pocket vs UF-based net-equity marks converted to CLP at month-end.
 */
export function deptoPropertyClpPaymentsThroughDate(
  ledger: readonly DeptoMortgageSheetRow[],
  asOf: string,
  afterExclusive: string | null
): number {
  const mk = asOf.slice(0, 7);
  let sum = 0;
  for (const r of ledger) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(r.occurred_on)) continue;
    if (r.occurred_on.slice(0, 7) !== mk) continue;
    if (afterExclusive != null && r.occurred_on <= afterExclusive) continue;
    if (r.occurred_on > asOf) continue;
    sum += Math.abs(r.pago_clp);
  }
  return sum;
}

/** UF día for display — always from `uf_daily`, never the duplicated sheet column. */
export function enrichDeptoRowsUfClpFromDb<T extends { occurred_on: string; uf_clp_day: number | null }>(
  rows: readonly T[]
): T[] {
  return rows.map((r) => {
    const uf = ufRowOnOrBefore(r.occurred_on);
    return { ...r, uf_clp_day: uf?.clp_per_uf ?? null };
  });
}

export function mortgageMetaFromSheetRows(rows: DeptoMortgageSheetRow[]): DeptoMortgageCsvMeta {
  const pie = rows.find((r) => r.cuota.toLowerCase() === "pie");
  // Gross value derived from row data (vnuf + cruf ≡ valor vivienda per row) — no constant,
  // so any property works (demo house included). Pie row first, else first derivable row.
  const grossOf = (r: DeptoMortgageSheetRow): number | null =>
    r.valor_neto_uf != null && r.credito_restante_uf != null
      ? roundUf4(r.valor_neto_uf + r.credito_restante_uf)
      : null;
  const valorViviendaUf =
    (pie ? grossOf(pie) : null) ??
    rows.map(grossOf).find((v): v is number => v != null) ??
    null;
  return {
    valor_vivienda_uf: valorViviendaUf,
    hipoteca_tras_pie_uf: pie?.credito_restante_uf ?? null,
    pie_clp: pie?.pago_clp ?? null,
    pie_uf: pie?.pago_uf ?? null,
    row_count: rows.length,
    csv_path: "SQLite|depto_dividendos_sheet_rows",
  };
}

/** Rows for `import:excel` property movements (subset of the sheet). */
export function loadDeptoDividendosPaymentRows(cfraserDir: string): DeptoDividendosPaymentRow[] {
  return loadDeptoDividendosSheetLedgerFromFile(cfraserDir).map(sheetRowToPaymentRow);
}

/** Down payment row — property (inmueble) capital, not a mortgage installment. */
export function isDeptoPieCuota(cuota: string): boolean {
  return String(cuota).trim().toLowerCase() === "pie";
}

/** Partial prepayment row on the dividendos sheet (`prepago 1`, `prepago 2`, …). */
export function isDeptoPrepagoCuota(cuota: string): boolean {
  return /^prepago/i.test(String(cuota).trim());
}

/** Rows that belong on the mortgage (pasivo) account: payments after pie, incl. prepagos. */
export function isDeptoMortgagePaymentCuota(cuota: string): boolean {
  return !isDeptoPieCuota(cuota);
}

/** First bank/Numbers payment row that is not pie (start of pasivo hipoteca series). */
export function firstDeptoMortgagePaymentYmd(
  ledger: readonly { cuota: string; occurred_on: string }[]
): string | null {
  let first: string | null = null;
  for (const r of ledger) {
    if (!isDeptoMortgagePaymentCuota(r.cuota)) continue;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(r.occurred_on)) continue;
    if (first == null || r.occurred_on < first) first = r.occurred_on;
  }
  return first;
}

/** Pie / purchase date — inmueble exists in patrimonio from here (not before). */
export function firstDeptoPropertyOwnershipYmd(
  ledger: readonly { cuota: string; occurred_on: string }[]
): string | null {
  for (const r of ledger) {
    if (!isDeptoPieCuota(r.cuota)) continue;
    if (/^\d{4}-\d{2}-\d{2}$/.test(r.occurred_on)) return r.occurred_on;
  }
  return firstDeptoMortgagePaymentYmd(ledger);
}

/** Drop pre-hipoteca snapshots (pie / balance-only rows before the first cuota). */
export function filterPointsFromFirstMortgagePayment<
  T extends Record<string, string | number | null>,
>(points: readonly T[], ledger: readonly { cuota: string; occurred_on: string }[]): T[] {
  const first = firstDeptoMortgagePaymentYmd(ledger);
  if (!first) return [...points];
  return points.filter((p) => String(p.as_of_date ?? "") >= first);
}

export function noteIsDeptoPiePayment(note: string | null | undefined): boolean {
  if (!note?.includes("import:excel|depto-")) return false;
  const raw = note.match(/\|cuota=([^|]+)/)?.[1];
  if (!raw) return false;
  try {
    return isDeptoPieCuota(decodeURIComponent(raw));
  } catch {
    return isDeptoPieCuota(raw);
  }
}

export function mortgageFlowKindFromCuota(
  cuota: string
): "pago_cuota_hipotecario" | "prepago_parcial_hipotecario" {
  if (/^prepago\b/i.test(String(cuota).trim())) return "prepago_parcial_hipotecario";
  return "pago_cuota_hipotecario";
}

export function buildDeptoMortgageMovementNote(r: DeptoDividendosPaymentRow): string {
  const kind = mortgageFlowKindFromCuota(r.cuota);
  return `${buildDeptoDividendosMovementNote(r, "depto-mortgage")}|flow_kind=${kind}`;
}

export function buildDeptoDividendosMovementNote(
  r: DeptoDividendosPaymentRow,
  tag: "depto-dividendos" | "depto-mortgage" = "depto-dividendos"
): string {
  const parts = [
    `import:excel|${tag}`,
    `cuota=${encodeURIComponent(r.cuota)}`,
    r.amount_uf != null ? `uf=${r.amount_uf}` : null,
    tag !== "depto-mortgage" && r.uf_clp_day != null
      ? `ufdia=${Math.round(r.uf_clp_day * 100) / 100}`
      : null,
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
    r.incendio_clp != null ? `fireclp=${Math.round(r.incendio_clp)}` : null,
    r.desgravamen_clp != null ? `desclp=${Math.round(r.desgravamen_clp)}` : null,
  ].filter(Boolean) as string[];
  return parts.join("|");
}

export function parseDeptoDividendosMovementNote(note: string | null): Partial<DeptoDividendosPaymentRow> & {
  cuota?: string;
} | null {
  if (
    !note ||
    (!note.startsWith("import:excel|depto-dividendos") &&
      !note.startsWith("import:excel|depto-mortgage") &&
      !note.startsWith("manual|depto-dividendos") &&
      !note.startsWith("manual|depto-mortgage"))
  ) {
    return null;
  }
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
    incendio_clp: num("fireclp"),
    desgravamen_clp: num("desclp"),
  };
}

