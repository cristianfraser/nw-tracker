/**
 * UNO cert periods with net cuotas that have no matching `import:excel` Table 1-3 month-end movement
 * (e.g. Excel `dep_afp` starts at 2017-06 but cert has 2017-05–06 activity).
 */
import { parseAfpCertificadoBody } from "./afpUnoCertMovimientosParse.js";
import { aggregateAfpCertCuotasByPeriodForTable1 } from "./afpUnoCertTable1Aggregation.js";
import type { AfpModeloCotizacionRow } from "./afpModeloCotizacionesParse.js";
import { aggregateModeloCuotasAndMontoByPeriod } from "./afpModeloCotizacionesParse.js";
import type { MonthKey } from "./afpModeloPriorCuotasBackfill.js";

export type OrphanCertMonthRow = {
  periodYm: MonthKey;
  occurredOn: string;
  unitsDelta: number;
  amountClp: number;
  note: string;
};

function monthEndFromYm(ym: string): string {
  const [ys, ms] = ym.split("-");
  const y = Number(ys);
  const mo = Number(ms);
  if (!Number.isFinite(y) || mo < 1 || mo > 12) return `${ym}-28`;
  return new Date(Date.UTC(y, mo, 0)).toISOString().slice(0, 10);
}

/** Month-end for cert period, capped at `asOfYmd` so in-progress months count in spot cuotas. */
export function certPeriodOccurredOn(periodYm: string, asOfYmd: string): string {
  const end = monthEndFromYm(periodYm);
  return end <= asOfYmd ? end : asOfYmd;
}

/** First `YYYY-MM` with a Table 1-3 AFP cumulative movement (month-end `occurred_on`). */
export function firstAfpCumulativeMovementMonth(
  movements: { occurred_on: string; note: string | null }[]
): MonthKey | null {
  let first: MonthKey | null = null;
  for (const m of movements) {
    if (!m.note?.includes("Table1-3|AFP")) continue;
    const mk = m.occurred_on.slice(0, 7) as MonthKey;
    if (first == null || mk < first) first = mk;
  }
  return first;
}

export function computeOrphanUnoCertMonthMovements(opts: {
  unoCertText: string;
  unoCertSourceFileName: string;
  modeloRows: AfpModeloCotizacionRow[];
  firstCumulativeMk: MonthKey | null;
  /** Month-ends with a Table 1-3 AFP cumulative row (may still have `units_delta` 0). */
  existingMovementMonths: Set<MonthKey>;
  /** `units_delta` on Table 1-3 row for that month (0 when cert sync left cuotas empty). */
  table1UnitsByMonth: Map<MonthKey, number>;
  /** Cap orphan `occurred_on` for the open month (default: omit → month-end only). */
  asOfYmd?: string;
}): OrphanCertMonthRow[] {
  const { rows: unoRows } = parseAfpCertificadoBody(opts.unoCertText, opts.unoCertSourceFileName);
  const unoBy = aggregateAfpCertCuotasByPeriodForTable1(unoRows);
  const modeloBy = aggregateModeloCuotasAndMontoByPeriod(opts.modeloRows);
  const out: OrphanCertMonthRow[] = [];

  for (const [periodYm, agg] of unoBy) {
    if (Math.abs(agg.cuotas) < 1e-4) continue;
    const table1Units = opts.table1UnitsByMonth.get(periodYm) ?? 0;
    if (Math.abs(table1Units - agg.cuotas) < 1e-4) continue;
    const gap = Math.max(0, agg.cuotas - table1Units);
    if (gap < 1e-4) continue;

    const modelo = modeloBy.get(periodYm);
    const amountClp =
      modelo != null && Math.abs(modelo.monto) > 0
        ? Math.round(modelo.monto)
        : Math.abs(agg.monto) > 0
          ? Math.round(agg.monto)
          : 1;
    const occurredOn = opts.asOfYmd ? certPeriodOccurredOn(periodYm, opts.asOfYmd) : monthEndFromYm(periodYm);
    out.push({
      periodYm,
      occurredOn,
      unitsDelta: Math.round(gap * 10000) / 10000,
      amountClp,
      note:
        `import:excel|afp-orphan-cert-month|period=${periodYm}|cert=${agg.cuotas.toFixed(4)}` +
        `|table1=${(table1Units ?? 0).toFixed(4)}|gap=${gap.toFixed(4)}` +
        (modelo ? `|modelo_monto=${Math.round(modelo.monto)}` : ""),
    });
  }
  return out;
}
