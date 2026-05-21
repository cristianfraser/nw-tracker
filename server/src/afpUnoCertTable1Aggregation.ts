import type { AfpCertMovementRow } from "./afpUnoCertParse.js";

/**
 * Movement types excluded when rolling certificate rows into monthly cuotas for Table 1-3
 * `units_delta` sync. Retiros are separate `import:excel|retiro-10pct` rows; internal cuenta
 * traspasos net ~0 within the month and must not be folded into deposit rows.
 */
export function excludeAfpCertRowFromTable1PeriodAggregation(tipoRaw: string): boolean {
  const t = tipoRaw.trim();
  if (/retiro\s*10\s*%/i.test(t)) return true;
  if (/^retiro\s+10/i.test(t)) return true;
  if (/traspaso\s+(ingreso|egreso)\s+cuentas/i.test(t)) return true;
  return false;
}

export function aggregateAfpCertCuotasByPeriodForTable1(
  rows: AfpCertMovementRow[]
): Map<string, { monto: number; cuotas: number; rows: AfpCertMovementRow[] }> {
  const m = new Map<string, { monto: number; cuotas: number; rows: AfpCertMovementRow[] }>();
  for (const r of rows) {
    if (excludeAfpCertRowFromTable1PeriodAggregation(r.tipoRaw)) continue;
    const a = m.get(r.periodYm) ?? { monto: 0, cuotas: 0, rows: [] };
    a.monto += r.montoClp;
    a.cuotas += r.cuotasDelta;
    a.rows.push(r);
    m.set(r.periodYm, a);
  }
  return m;
}
