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
 * Only CLP salary liquidaciones count (a USD wire is fees, not art. 42 N°1). A month whose
 * taxable base is printed but whose AFP or health contribution was not parsed is listed in
 * `incompleteMonths` — its taxable pay is overstated (the 2019 Dealsyte months) — and so is one
 * whose totals were not parsed at all (left out: the scanned 2018-08).
 */
import { db } from "./db.js";
import { monthBeforeYmd } from "./foreignShareTaxGains.js";
import { latestOfficialIpcMonth, loadOfficialIpcLookup, officialIpcVariationPctBetween } from "./siiOfficialIpc.js";

export const LEGAL_HEALTH_RATE = 0.07;

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

/** The month's taxable pay, or null when the liquidación's totals were not parsed. */
export function monthTaxablePay(r: Row): number | null {
  const haberes =
    r.total_haberes_clp ??
    (r.total_imponible_clp != null && r.total_no_imponible_clp != null
      ? r.total_imponible_clp + r.total_no_imponible_clp
      : null);
  if (haberes == null) return null;
  const noImponible = r.total_no_imponible_clp ?? (r.colacion_clp ?? 0) + (r.movilizacion_clp ?? 0);
  const health =
    r.total_imponible_clp != null && r.desc_health_clp != null
      ? Math.min(r.desc_health_clp, Math.round(LEGAL_HEALTH_RATE * r.total_imponible_clp))
      : (r.desc_health_clp ?? 0);
  return haberes - noImponible - (r.desc_afp_clp ?? 0) - health - (r.desc_cesantia_clp ?? 0);
}

export function payrollTaxYear(incomeYear: number): PayrollTaxYear {
  const rows = db
    .prepare(
      `SELECT period_month, total_haberes_clp, total_imponible_clp, total_no_imponible_clp, colacion_clp,
              movilizacion_clp, desc_afp_clp, desc_health_clp, desc_cesantia_clp, desc_tax_clp
         FROM payroll_work_earnings
        WHERE period_month LIKE ? AND earning_type = 'salary' AND liquido_currency = 'clp'
        ORDER BY period_month`
    )
    .all(`${incomeYear}-%`) as Row[];
  const ipc = loadOfficialIpcLookup();
  const latest = latestOfficialIpcMonth();
  const provisional = latest < `${incomeYear}-11-01`;
  const toMonth = provisional ? latest : `${incomeYear}-11-01`;
  let taxable = 0;
  let withheld = 0;
  const incompleteMonths: string[] = [];
  for (const r of rows) {
    const from = monthBeforeYmd(`${r.period_month}-01`);
    const pct = from >= toMonth ? 0 : Math.max(0, Math.round(officialIpcVariationPctBetween(from, toMonth, ipc) * 10) / 10);
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
