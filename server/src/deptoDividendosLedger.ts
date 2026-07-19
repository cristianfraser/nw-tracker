import { db } from "./db.js";
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

/** One payment / capital row from Numbers export `depto-dividendos.csv` (sheet “dividendos”). */
export type DeptoDividendosPaymentRow = {
  cuota: string;
  occurred_on: string;
  amount_clp: number;
  amount_uf: number | null;
  uf_clp_day: number | null;
  credito_restante_uf: number | null;
  /** Tasación / valor vivienda (UF) — observed value; net equity is DERIVED (gross − balance). */
  valor_vivienda_uf: number | null;
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


function roundUf4(v: number): number {
  return Math.round(v * 1e4) / 1e4;
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




export function sheetRowToPaymentRow(s: DeptoMortgageSheetRow): DeptoDividendosPaymentRow {
  return {
    cuota: s.cuota,
    occurred_on: s.occurred_on,
    amount_clp: s.pago_clp,
    amount_uf: s.pago_uf,
    uf_clp_day: s.uf_clp_day,
    credito_restante_uf: s.credito_restante_uf,
    valor_vivienda_uf: s.valor_vivienda_uf,
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
 * Net equity UF at each snapshot — DERIVED as gross − balance: forward-filled
 * **valor vivienda (UF)** (the observed tasación, a row column) minus forward-filled
 * **crédito restante (UF)**. Prepago rows are skipped in both fills (their balances are
 * unreliable in the Numbers export). Only on/after pie / compra.
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
  let gross: number | null = null;
  let balance: number | null = null;
  for (const d of dateStrsAsc) {
    const cut = snapshotDepositCutoff(d);
    while (j < sorted.length && sorted[j]!.occurred_on <= cut) {
      const row = sorted[j]!;
      if (!isDeptoPrepagoCuota(row.cuota)) {
        if (row.valor_vivienda_uf != null && Number.isFinite(row.valor_vivienda_uf)) {
          gross = row.valor_vivienda_uf;
        }
        if (row.credito_restante_uf != null && Number.isFinite(row.credito_restante_uf)) {
          balance = row.credito_restante_uf;
        }
      }
      j++;
    }
    if (firstOwn != null && d < firstOwn) continue;
    if (gross != null && balance != null) {
      out.set(d, roundUf4(Math.max(0, gross - balance)));
    }
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

// ---------- depto_payments table (machine payload; notes are human provenance) ----------

/** One `depto_payments` row: the payment fields runtime derives the ledger from. */
export type DeptoPaymentTableRow = {
  movement_id: number;
  kind: "dividendos" | "mortgage";
  origin: "import" | "manual";
  cuota: string;
  amount_uf: number | null;
  credito_restante_uf: number | null;
  valor_vivienda_uf: number | null;
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
  incendio_clp: number | null;
  desgravamen_clp: number | null;
};

export function deptoPaymentRowForMovementId(movementId: number): DeptoPaymentTableRow | null {
  const r = db
    .prepare(`SELECT * FROM depto_payments WHERE movement_id = ?`)
    .get(movementId) as DeptoPaymentTableRow | undefined;
  return r ?? null;
}

/** Movement ids of "pie" (down payment) rows — property capital, excluded from payment lists. */
export function deptoPieMovementIdSet(): Set<number> {
  const rows = db
    .prepare(`SELECT movement_id FROM depto_payments WHERE LOWER(TRIM(cuota)) = 'pie'`)
    .all() as { movement_id: number }[];
  return new Set(rows.map((r) => r.movement_id));
}

export function insertDeptoPaymentRow(row: DeptoPaymentTableRow): void {
  db.prepare(
    `INSERT INTO depto_payments (
       movement_id, kind, origin, cuota,
       amount_uf, credito_restante_uf, valor_vivienda_uf, valor_neto_uf, valor_neto_clp,
       pagado_neto_uf, pago_acumulado_clp, min_uf,
       amortizacion_clp, amortizacion_uf, amortizacion_ext_clp, amortizacion_ext_uf,
       interes_clp, interes_uf, incendio_clp, desgravamen_clp
     ) VALUES (
       @movement_id, @kind, @origin, @cuota,
       @amount_uf, @credito_restante_uf, @valor_vivienda_uf, @valor_neto_uf, @valor_neto_clp,
       @pagado_neto_uf, @pago_acumulado_clp, @min_uf,
       @amortizacion_clp, @amortizacion_uf, @amortizacion_ext_clp, @amortizacion_ext_uf,
       @interes_clp, @interes_uf, @incendio_clp, @desgravamen_clp
     )`
  ).run(row);
}

/** `depto_payments` columns for a payment row (shared by manual entry, recompute, and demo data). */
export function deptoPaymentColumnsFromPaymentRow(
  r: DeptoDividendosPaymentRow
): Omit<DeptoPaymentTableRow, "movement_id" | "kind" | "origin"> {
  return {
    cuota: r.cuota,
    amount_uf: r.amount_uf ?? null,
    credito_restante_uf: r.credito_restante_uf ?? null,
    valor_vivienda_uf: r.valor_vivienda_uf ?? null,
    valor_neto_uf: r.valor_neto_uf ?? null,
    valor_neto_clp: r.valor_neto_clp != null ? Math.round(r.valor_neto_clp) : null,
    pagado_neto_uf: r.pagado_neto_uf ?? null,
    pago_acumulado_clp: r.pago_acumulado_clp != null ? Math.round(r.pago_acumulado_clp) : null,
    min_uf: r.min_uf ?? null,
    amortizacion_clp: r.amortizacion_clp != null ? Math.round(r.amortizacion_clp) : null,
    amortizacion_uf: r.amortizacion_uf ?? null,
    amortizacion_ext_clp: r.amortizacion_ext_clp != null ? Math.round(r.amortizacion_ext_clp) : null,
    amortizacion_ext_uf: r.amortizacion_ext_uf ?? null,
    interes_clp: r.interes_clp != null ? Math.round(r.interes_clp) : null,
    interes_uf: r.interes_uf ?? null,
    incendio_clp: r.incendio_clp != null ? Math.round(r.incendio_clp) : null,
    desgravamen_clp: r.desgravamen_clp != null ? Math.round(r.desgravamen_clp) : null,
  };
}

/** Human note for a depto payment movement (machine payload lives in `depto_payments`). */
export function deptoPaymentHumanNote(
  kind: "dividendos" | "mortgage",
  cuota: string,
  manual: boolean
): string {
  const base = isDeptoPieCuota(cuota)
    ? "Depto pie"
    : kind === "mortgage"
      ? `Pago hipoteca — cuota ${cuota}`
      : `Depto dividendo — cuota ${cuota}`;
  return manual ? `${base} (manual)` : base;
}

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

/** Mortgage payment cash events (cuotas + prepagos; pie is property capital) with `occurred_on` ≤ `asOf`. */
export function mortgageSheetPaymentEventsThroughDate(
  ledger: readonly DeptoMortgageSheetRow[],
  asOf: string
): { occurred_on: string; pago_clp: number }[] {
  const out: { occurred_on: string; pago_clp: number }[] = [];
  for (const r of ledger) {
    if (!isDeptoMortgagePaymentCuota(r.cuota)) continue;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(r.occurred_on)) continue;
    if (r.occurred_on > asOf) continue;
    out.push({ occurred_on: r.occurred_on, pago_clp: Math.abs(r.pago_clp) });
  }
  return out;
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
  // Gross is an observed row column (tasación) — pie row first, else first row carrying it.
  const valorViviendaUf =
    pie?.valor_vivienda_uf ??
    rows.map((r) => r.valor_vivienda_uf).find((v): v is number => v != null) ??
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

export function mortgageFlowKindFromCuota(
  cuota: string
): "pago_cuota_hipotecario" | "prepago_parcial_hipotecario" {
  if (/^prepago\b/i.test(String(cuota).trim())) return "prepago_parcial_hipotecario";
  return "pago_cuota_hipotecario";
}


