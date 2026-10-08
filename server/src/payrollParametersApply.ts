/**
 * `payroll.parameters` → `payroll_parameters` + `payroll_afp_rates`, one row per payroll month
 * (replaced as a whole when re-sent; a changed figure is reported). Read by the payslip checks
 * (`payslipChecks.ts`).
 */
import type { PayrollParametersApplyDetails, PayrollParametersPayload } from "nw-tracker-contracts";
import { db } from "./db.js";

const FIELDS = ["uf", "utm", "pension_cap_uf", "unemployment_cap_uf", "afp_employer_rate", "afc_worker_rate", "afc_employer_rate"] as const;

export type PayrollParametersRow = Record<(typeof FIELDS)[number], number> & {
  period_month: string;
  afp_worker_rates: Record<string, number>;
};

export function applyPayrollParameters(payload: PayrollParametersPayload): PayrollParametersApplyDetails {
  const details: PayrollParametersApplyDetails = { months: payload.months.length, added: [], changed: [] };
  const select = db.prepare(`SELECT * FROM payroll_parameters WHERE period_month = ?`);
  const selectRates = db.prepare(`SELECT afp, worker_rate FROM payroll_afp_rates WHERE period_month = ?`);
  const upsert = db.prepare(
    `INSERT INTO payroll_parameters (period_month, uf, utm, pension_cap_uf, unemployment_cap_uf, afp_employer_rate, afc_worker_rate, afc_employer_rate, document)
     VALUES (@period_month, @uf, @utm, @pension_cap_uf, @unemployment_cap_uf, @afp_employer_rate, @afc_worker_rate, @afc_employer_rate, @document)
     ON CONFLICT(period_month) DO UPDATE SET uf = excluded.uf, utm = excluded.utm, pension_cap_uf = excluded.pension_cap_uf,
       unemployment_cap_uf = excluded.unemployment_cap_uf, afp_employer_rate = excluded.afp_employer_rate,
       afc_worker_rate = excluded.afc_worker_rate, afc_employer_rate = excluded.afc_employer_rate,
       document = excluded.document, updated_at = datetime('now')`
  );
  const deleteRates = db.prepare(`DELETE FROM payroll_afp_rates WHERE period_month = ?`);
  const insertRate = db.prepare(`INSERT INTO payroll_afp_rates (period_month, afp, worker_rate) VALUES (?, ?, ?)`);
  db.transaction(() => {
    for (const m of payload.months) {
      const stored = select.get(m.period_month) as Record<string, number> | undefined;
      if (!stored) details.added.push(m.period_month);
      else {
        for (const f of FIELDS) if (stored[f] !== m[f]) details.changed.push(`${m.period_month}: ${f} ${stored[f]} → ${m[f]}`);
        const oldRates = Object.fromEntries((selectRates.all(m.period_month) as { afp: string; worker_rate: number }[]).map((r) => [r.afp, r.worker_rate]));
        for (const [afp, rate] of Object.entries(m.afp_worker_rates)) {
          if (oldRates[afp] !== rate) details.changed.push(`${m.period_month}: ${afp} ${oldRates[afp] ?? "—"} → ${rate}`);
        }
      }
      upsert.run(m);
      deleteRates.run(m.period_month);
      for (const [afp, rate] of Object.entries(m.afp_worker_rates)) insertRate.run(m.period_month, afp, rate);
    }
  })();
  return details;
}

/** Every stored month's parameters, by month. */
export function loadPayrollParameters(): Map<string, PayrollParametersRow> {
  const out = new Map<string, PayrollParametersRow>();
  for (const r of db.prepare(`SELECT * FROM payroll_parameters`).all() as (PayrollParametersRow & { document: string })[]) {
    out.set(r.period_month, { ...r, afp_worker_rates: {} });
  }
  for (const r of db.prepare(`SELECT period_month, afp, worker_rate FROM payroll_afp_rates`).all() as {
    period_month: string;
    afp: string;
    worker_rate: number;
  }[]) {
    out.get(r.period_month)!.afp_worker_rates[r.afp] = r.worker_rate;
  }
  return out;
}
