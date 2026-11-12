/**
 * A year's employment income as the F22 takes it (codes 1098 / 161 «sueldos… art. 42 N°1» and
 * 162 «crédito por IUSC»), rebuilt from the imported liquidaciones the way the employer's DJ 1887
 * reports it: each month's taxable pay — haberes less the non-taxable allowances (colación,
 * movilización: TOTAL NO IMPONIBLE) and the worker's social-security contributions (AFP, health up
 * to the legal 7% of the taxable base, unemployment insurance) — and the impuesto único withheld,
 * both «actualizados» to December by the SII's year-end factor for the month (the official IPC
 * from the month before to November, one decimal, never negative). Checked against the filed
 * returns: AT2023 and AT2026 to the peso, AT2021 / AT2025 within the factors' rounding.
 *
 * Only Chilean CLP salary liquidaciones count (a USD wire is fees, not art. 42 N°1; a US W-2 pay
 * stub is US-source pay, filed on the 1040). A month whose
 * taxable base is printed but whose AFP or health contribution was not parsed is listed in
 * `incompleteMonths` — its taxable pay is overstated (the 2019 Dealsyte months) — and so is one
 * whose totals were not parsed at all (left out: the scanned 2018-08).
 */
import { wholeYearWindow, windowWithinYear, type DateWindow } from "../dateWindow.js";
import { chileanPayslipFacts, type ChileanPayslipFact } from "../taxFacts/salaries.js";
import { iuscTaxableClp } from "../payslipLineKinds.js";
import { ipcReajuste, monthBeforeYmd } from "../siiOfficialIpc.js";

export type PayrollTaxYear = {
  incomeYear: number;
  months: number;
  /** 1098 / 161: taxable pay, actualizada. */
  taxablePayClp: number;
  /** 162: impuesto único withheld, actualizado. */
  withheldTaxClp: number;
  incompleteMonths: string[];
  /** November not published yet: the factors run to the latest published month. */
  provisional: boolean;
};

/** The liquidación totals {@link monthTaxablePay} reads (a {@link ChileanPayslipFact}'s, in the DB's column names). */
type Row = {
  period_month: string;
  total_haberes_clp: number | null;
  total_imponible_clp: number | null;
  total_no_imponible_clp: number | null;
  colacion_clp: number | null;
  movilizacion_clp: number | null;
  desc_afp_clp: number | null;
  desc_health_clp: number | null;
  desc_cesantia_clp: number | null;
  desc_tax_clp: number | null;
};

function rowOfFact(f: ChileanPayslipFact): Row {
  return {
    period_month: f.periodMonth,
    total_haberes_clp: f.totalHaberesClp,
    total_imponible_clp: f.totalImponibleClp,
    total_no_imponible_clp: f.totalNoImponibleClp,
    colacion_clp: f.colacionClp,
    movilizacion_clp: f.movilizacionClp,
    desc_afp_clp: f.descAfpClp,
    desc_health_clp: f.descHealthClp,
    desc_cesantia_clp: f.descCesantiaClp,
    desc_tax_clp: f.descTaxClp,
  };
}

/** The month's taxable pay, or null when the liquidación's totals were not parsed. */
export function monthTaxablePay(r: Row): number | null {
  const haberes =
    r.total_haberes_clp ??
    (r.total_imponible_clp != null && r.total_no_imponible_clp != null
      ? r.total_imponible_clp + r.total_no_imponible_clp
      : null);
  if (haberes == null) return null;
  const noImponible = r.total_no_imponible_clp ?? (r.colacion_clp ?? 0) + (r.movilizacion_clp ?? 0);
  const contributions = { taxablePay: haberes - noImponible, pension: r.desc_afp_clp ?? 0, unemployment: r.desc_cesantia_clp ?? 0 };
  if (r.total_imponible_clp != null && r.desc_health_clp != null) {
    return iuscTaxableClp({ ...contributions, healthPaid: r.desc_health_clp, taxableBase: r.total_imponible_clp });
  }
  // No base to cap health against: the health line as printed.
  return contributions.taxablePay - contributions.pension - (r.desc_health_clp ?? 0) - contributions.unemployment;
}

/**
 * The year's Chilean salary payslips (`jurisdiction = 'cl'`), or those of one part of a departure
 * year: a payslip belongs to the window holding its period month (`taxResidency.ts`).
 */
export function payrollTaxYear(incomeYear: number, window: DateWindow = wholeYearWindow(incomeYear)): PayrollTaxYear {
  const inYear = windowWithinYear(incomeYear, window);
  // A Chilean art. 42 N°1 salary: a peso salary liquidación (a finiquito or a dollar wire is not).
  const rows = (inYear ? chileanPayslipFacts(inYear) : [])
    .filter((f) => f.earningType === "salary" && f.liquidoCurrency === "clp") // convention-ok: a liquidación pays pesos; a US stub is the 1030 path
    .map(rowOfFact);
  const ipc = ipcReajuste({ round: true, floorAtZero: true });
  const { toMonth, provisional } = ipc.december(incomeYear);
  let taxable = 0;
  let withheld = 0;
  const incompleteMonths: string[] = [];
  for (const r of rows) {
    const from = monthBeforeYmd(`${r.period_month}-01`);
    const pct = ipc.pct(from, toMonth);
    const factor = 1 + pct / 100;
    const pay = monthTaxablePay(r);
    if (pay == null) {
      incompleteMonths.push(r.period_month);
      continue;
    }
    taxable += pay * factor;
    withheld += (r.desc_tax_clp ?? 0) * factor;
    if ((r.total_imponible_clp ?? 0) > 0 && (r.desc_afp_clp == null || r.desc_health_clp == null)) {
      incompleteMonths.push(r.period_month);
    }
  }
  return {
    incomeYear,
    months: rows.length,
    taxablePayClp: Math.round(taxable),
    withheldTaxClp: Math.round(withheld),
    incompleteMonths,
    provisional,
  };
}
