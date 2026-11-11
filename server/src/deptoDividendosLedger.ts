import { db } from "./db.js";
import { ufRowOnOrBefore } from "./fxRates.js";

/**
 * One payment / capital row as the bank states it: the pesos paid and their parts, the balance
 * after it and the minimum / maximum cuota in UF. Everything else the ledger shows (the parts in
 * UF, net equity, cumulative figures) is derived when read (`deptoLedgerFromMovements.ts`).
 */
export type DeptoDividendosPaymentRow = {
  cuota: string;
  occurred_on: string;
  amount_clp: number;
  credito_restante_uf: number | null;
  /** The bank's cuota mínima (UF). */
  min_uf: number | null;
  /** The bank's posted cuota máxima (UF), as the bank stated it (the lender's quote, the form or the retired sheet import). */
  max_uf: number | null;
  amortizacion_clp: number | null;
  amortizacion_ext_clp: number | null;
  interes_clp: number | null;
  incendio_clp: number | null;
  desgravamen_clp: number | null;
};

function roundUf4(v: number): number {
  return Math.round(v * 1e4) / 1e4;
}

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
  /** The next row's minimum and maximum are the lender's quote, not a projection. */
  quoted?: boolean;
};

/** Σ of the parts that are present; null when none is (a sheet row that carries none of them). */
export function sumPresent(round: (v: number) => number, ...parts: Array<number | null>): number | null {
  const present = parts.filter((v): v is number => v != null);
  return present.length ? round(present.reduce((a, b) => a + b, 0)) : null;
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
  max_uf: number | null;
  incendio_clp: number | null;
  incendio_uf: number | null;
  desgravamen_clp: number | null;
  desgravamen_uf: number | null;
  total_seguros_uf: number | null;
  total_seguros_clp: number | null;
  /** Insurance + interest — the cost of the cuota that buys no equity; null when every part is null. */
  seguros_interes_uf: number | null;
  seguros_interes_clp: number | null;
  amortizacion_clp: number | null;
  amortizacion_uf: number | null;
  amortizacion_ext_clp: number | null;
  amortizacion_ext_uf: number | null;
  /** Scheduled + extra amortización; null when both are null. */
  amortizacion_total_uf: number | null;
  amortizacion_total_clp: number | null;
  interes_clp: number | null;
  interes_uf: number | null;
  /** A prepago's prepayment charge (the lender's comisión, a cost); null on a cuota. */
  prepayment_charge_clp: number | null;
  prepayment_charge_uf: number | null;
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
    credito_restante_uf: s.credito_restante_uf,
    min_uf: s.min_uf,
    max_uf: s.max_uf,
    amortizacion_clp: s.amortizacion_clp,
    amortizacion_ext_clp: s.amortizacion_ext_clp,
    interes_clp: s.interes_clp,
    incendio_clp: s.incendio_clp,
    desgravamen_clp: s.desgravamen_clp,
  };
}

/** Full “dividendos” sheet (one row per bank transfer / pie). Source for account UI. */
/** Align month-end snapshot labels with dividendos payment dates (see valuation chart cutoffs). */
/**
 * Chronological ledger order: by date; same-day rows by decreasing crédito restante (a
 * running balance only falls within a day, so the smaller balance is the later payment —
 * fixes prepago+cuota pairs sharing one date, where the cuota-label sort applied them
 * backwards); cuota label as the final tiebreak.
 */
export function deptoLedgerChronoCompare(
  a: { occurred_on: string; credito_restante_uf: number | null; cuota: string },
  b: { occurred_on: string; credito_restante_uf: number | null; cuota: string }
): number {
  const c = a.occurred_on.localeCompare(b.occurred_on);
  if (c !== 0) return c;
  if (
    a.credito_restante_uf != null &&
    b.credito_restante_uf != null &&
    a.credito_restante_uf !== b.credito_restante_uf
  ) {
    return b.credito_restante_uf - a.credito_restante_uf;
  }
  return a.cuota.localeCompare(b.cuota);
}

/**
 * Fail fast on a mis-sequenced prepago: a prepago strictly reduces the balance, so its
 * `credito_restante_uf` must not exceed the chronologically previous row's. (Regular cuotas
 * CAN follow a balance increase — grace-period interest capitalizes between pie and the
 * first billed cuota — so only prepago rows carry this invariant.) A violation means the
 * row still holds a month-grain non-sequential balance: fix the `loan_payments` data.
 */
export function assertDeptoPrepagoSequencing(
  rowsChronoAsc: readonly Pick<
    DeptoMortgageSheetRow,
    "cuota" | "occurred_on" | "credito_restante_uf"
  >[]
): void {
  let prev: number | null = null;
  let prevCuota = "";
  for (const row of rowsChronoAsc) {
    const v = row.credito_restante_uf;
    if (v == null || !Number.isFinite(v)) continue;
    if (isDeptoPrepagoCuota(row.cuota) && prev != null && v > prev + 1e-6) {
      throw new Error(
        `depto ledger: prepago "${row.cuota}" (${row.occurred_on}) has credito_restante_uf ` +
          `${v} > previous row "${prevCuota}" ${prev} — non-sequential balance, fix loan_payments`
      );
    }
    prev = v;
    prevCuota = row.cuota;
  }
}

/**
 * Forward-filled **crédito restante (UF)** from the depto ledger at each snapshot date:
 * last row with `occurred_on <=` the exact date, in chronological order — a prepago's
 * balance drop lands on the prepago's own date (rows are sequential per
 * {@link assertDeptoPrepagoSequencing}; the old first-of-month → month-end cutoff
 * expansion and the prepago-row skip are gone — both invented month-grain values on a
 * daily grid).
 */
export function deptoCreditoRestanteUfBySnapshotDates(
  dateStrsAsc: readonly string[],
  ledger: readonly DeptoMortgageSheetRow[]
): Map<string, number> {
  const out = new Map<string, number>();
  if (dateStrsAsc.length === 0 || ledger.length === 0) return out;
  const sorted = [...ledger].sort(deptoLedgerChronoCompare);
  let j = 0;
  let last: number | null = null;
  for (const d of dateStrsAsc) {
    while (j < sorted.length && sorted[j]!.occurred_on <= d) {
      const v = sorted[j]!.credito_restante_uf;
      if (v != null && Number.isFinite(v)) last = v;
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
 * **crédito restante (UF)**, both at the exact snapshot date in chronological order
 * (prepago rows included — their balance drop lands on their own date). Only on/after
 * pie / compra.
 */
export function deptoNetEquityUfBySnapshotDates(
  dateStrsAsc: readonly string[],
  ledger: readonly DeptoMortgageSheetRow[]
): Map<string, number> {
  const firstOwn = firstDeptoPropertyOwnershipYmd(ledger);
  const out = new Map<string, number>();
  if (dateStrsAsc.length === 0 || ledger.length === 0) return out;
  const sorted = [...ledger].sort(deptoLedgerChronoCompare);
  let j = 0;
  let gross: number | null = null;
  let balance: number | null = null;
  for (const d of dateStrsAsc) {
    while (j < sorted.length && sorted[j]!.occurred_on <= d) {
      const row = sorted[j]!;
      if (row.valor_vivienda_uf != null && Number.isFinite(row.valor_vivienda_uf)) {
        gross = row.valor_vivienda_uf;
      }
      if (row.credito_restante_uf != null && Number.isFinite(row.credito_restante_uf)) {
        balance = row.credito_restante_uf;
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
export function deptoPropertyCloseClpBySnapshotDates(
  dateStrsAsc: readonly string[],
  ledger: readonly DeptoMortgageSheetRow[],
  ufClpByDate: Map<string, number>
): Map<string, number> {
  const netUf = deptoNetEquityUfBySnapshotDates(dateStrsAsc, ledger);
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

// ---------- loan_payments / the property's appraisals (machine payload; notes are human provenance) ----------

/** The account a payment movement sits on: the property account's row or the mortgage's. */
export type LoanPaymentLeg = "property" | "loan";

/**
 * One `loan_payments` row: what the bank states about one payment, in the currency it states
 * it — balance after / min / max in `loan_currency`, the parts of the charge in
 * `payment_currency`. The depto ledger reads UF loans paid in pesos only
 * ({@link assertDeptoLoanPaymentCurrencies}).
 */
export type LoanPaymentRow = {
  movement_id: number;
  loan_account_id: number;
  leg: LoanPaymentLeg;
  origin: "import" | "manual";
  cuota: string;
  loan_currency: string;
  balance_after: number | null;
  min_payment: number | null;
  max_payment: number | null;
  payment_currency: string;
  principal: number | null;
  extra_principal: number | null;
  interest: number | null;
  insurance_fire: number | null;
  insurance_life: number | null;
  /** A prepago's COMISIÓN DE PREPAGO (+ any interés penal): a cost, never art. 55 bis interest; null on a cuota. */
  prepayment_charge: number | null;
};

/** The columns a payment row fills (everything but the movement, account, leg and origin). */
export type LoanPaymentColumns = Omit<LoanPaymentRow, "movement_id" | "loan_account_id" | "leg" | "origin">;

/** Fail fast: the depto ledger's in-memory shape is a UF loan with its parts in pesos. */
export function assertDeptoLoanPaymentCurrencies(
  row: Pick<LoanPaymentRow, "movement_id" | "loan_currency" | "payment_currency">
): void {
  if (row.loan_currency !== "uf" || row.payment_currency !== "clp") {
    throw new Error(
      `loan_payments row ${row.movement_id}: the depto ledger reads a UF loan paid in pesos, got loan ${row.loan_currency} / payment ${row.payment_currency}`
    );
  }
}

export function loanPaymentRowForMovementId(movementId: number): LoanPaymentRow | null {
  const r = db
    .prepare(`SELECT * FROM loan_payments WHERE movement_id = ?`)
    .get(movementId) as LoanPaymentRow | undefined;
  return r ?? null;
}

/** Movement ids of "pie" (down payment) rows — property capital, excluded from payment lists. */
export function deptoPieMovementIdSet(): Set<number> {
  const rows = db
    .prepare(`SELECT movement_id FROM loan_payments WHERE LOWER(TRIM(cuota)) = 'pie'`)
    .all() as { movement_id: number }[];
  return new Set(rows.map((r) => r.movement_id));
}

export function insertLoanPaymentRow(row: LoanPaymentRow): void {
  db.prepare(
    `INSERT INTO loan_payments (
       movement_id, loan_account_id, leg, origin, cuota,
       loan_currency, balance_after, min_payment, max_payment,
       payment_currency, principal, extra_principal, interest, insurance_fire, insurance_life, prepayment_charge
     ) VALUES (
       @movement_id, @loan_account_id, @leg, @origin, @cuota,
       @loan_currency, @balance_after, @min_payment, @max_payment,
       @payment_currency, @principal, @extra_principal, @interest, @insurance_fire, @insurance_life, @prepayment_charge
     )`
  ).run(row);
}

/** `loan_payments` columns for a depto payment row (shared by manual entry, recompute, and demo data). */
export function loanPaymentColumnsFromPaymentRow(r: DeptoDividendosPaymentRow): LoanPaymentColumns {
  const peso = (v: number | null | undefined) => (v != null ? Math.round(v) : null);
  return {
    cuota: r.cuota,
    loan_currency: "uf",
    balance_after: r.credito_restante_uf ?? null,
    min_payment: r.min_uf ?? null,
    max_payment: r.max_uf ?? null,
    payment_currency: "clp",
    principal: peso(r.amortizacion_clp),
    extra_principal: peso(r.amortizacion_ext_clp),
    interest: peso(r.interes_clp),
    insurance_fire: peso(r.incendio_clp),
    insurance_life: peso(r.desgravamen_clp),
    // A cuota has no prepayment charge; a prepago's is set from its liquidation (the cross-check script).
    prepayment_charge: null,
  };
}

/**
 * The property's appraisal on a date: a `valuations` row of the property account in UF (a
 * property's valuations are its appraisals; its value is net equity, derived by the ledger). The
 * ledger carries the latest one on or before each row. Writing the same date twice must state the
 * same value.
 */
export function upsertPropertyAppraisalUf(accountId: number, asOfYmd: string, valueUf: number): void {
  const prev = db
    .prepare(`SELECT value, currency FROM valuations WHERE account_id = ? AND as_of_date = ?`)
    .get(accountId, asOfYmd) as { value: number; currency: string } | undefined;
  if (prev) {
    if (prev.currency !== "uf" || prev.value !== valueUf) {
      throw new Error(
        `property appraisal ${accountId} ${asOfYmd}: stored ${prev.value} ${prev.currency}, new ${valueUf} uf`
      );
    }
    return;
  }
  db.prepare(
    `INSERT INTO valuations (account_id, as_of_date, value, currency) VALUES (?, ?, ?, 'uf')`
  ).run(accountId, asOfYmd, valueUf);
}

/** Appraisals of a property account in UF, oldest first (a valuation in another currency throws). */
export function propertyAppraisalsUfAsc(accountId: number): { as_of_date: string; value_uf: number }[] {
  const rows = db
    .prepare(`SELECT as_of_date, value, currency FROM valuations WHERE account_id = ? ORDER BY as_of_date`)
    .all(accountId) as { as_of_date: string; value: number; currency: string }[];
  return rows.map((r) => {
    if (r.currency !== "uf") {
      throw new Error(`property appraisal ${accountId} ${r.as_of_date}: the depto ledger reads UF, got ${r.currency}`);
    }
    return { as_of_date: r.as_of_date, value_uf: r.value };
  });
}

/** Human note for a depto payment movement (machine payload lives in `loan_payments`). */
export function deptoPaymentHumanNote(
  leg: LoanPaymentLeg,
  cuota: string,
  manual: boolean
): string {
  const base = isDeptoPieCuota(cuota)
    ? "Depto pie"
    : leg === "loan"
      ? `Pago hipoteca — cuota ${cuota}`
      : `Depto dividendo — cuota ${cuota}`;
  return manual ? `${base} (manual)` : base;
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
 * Property capital cash events (pie, cuotas, prepagos — the pesos actually paid) with
 * `occurred_on` ≤ `asOf`. P/L compares pesos out of pocket vs UF-based net-equity marks
 * converted to CLP at month-end.
 */
export function deptoPropertyPaymentEventsThroughDate(
  ledger: readonly DeptoMortgageSheetRow[],
  asOf: string
): { occurred_on: string; pago_clp: number }[] {
  const out: { occurred_on: string; pago_clp: number }[] = [];
  for (const r of ledger) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(r.occurred_on)) continue;
    if (r.occurred_on > asOf) continue;
    out.push({ occurred_on: r.occurred_on, pago_clp: Math.abs(r.pago_clp) });
  }
  return out;
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

export function mortgageFlowKindFromCuota(
  cuota: string
): "pago_cuota_hipotecario" | "prepago_parcial_hipotecario" {
  if (/^prepago\b/i.test(String(cuota).trim())) return "prepago_parcial_hipotecario";
  return "pago_cuota_hipotecario";
}

