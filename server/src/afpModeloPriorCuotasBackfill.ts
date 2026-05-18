import fs from "node:fs";
import path from "node:path";
import type { AfpCertMovementRow } from "./afpUnoCertParse.js";
import { parseDecimalComma } from "./afpUnoCertParse.js";
import { parseAfpCertificadoBody } from "./afpUnoCertMovimientosParse.js";
import {
  parseAfpModeloAntecedentesCsv,
  type AfpModeloAntecedentesSnapshot,
} from "./afpModeloAntecedentesParse.js";
import {
  aggregateModeloCuotasAndMontoByPeriod,
  parseAfpModeloCotizacionesCsv,
  type AfpModeloCotizacionRow,
} from "./afpModeloCotizacionesParse.js";

/** Synthetic trim after cert/orphan backfill so header Σ cuotas matches AFP UNO website. */
export const AFP_CUOTAS_SYNTHETIC_TRIM_DELTA = -0.66;
export const AFP_CUOTAS_SYNTHETIC_TRIM_TARGET = 292.08;

export type MonthKey = string;

export type DepAfpBucket = { dep_afp?: number | null };

/** Same month-on-month Δ as `emitCumulativeDeltasAfpMinusDocumentedRetiros` uses from cumulative `dep_afp`. */
export function buildDepAfpDeltaByMonth(
  monthsSorted: MonthKey[],
  getBucket: (mk: MonthKey) => DepAfpBucket | undefined
): Map<MonthKey, number> {
  let prev: number | null = null;
  const out = new Map<MonthKey, number>();
  for (const mk of monthsSorted) {
    const cum = getBucket(mk)?.dep_afp;
    if (cum == null || !Number.isFinite(cum)) continue;
    if (prev !== null) {
      const d = cum - prev;
      if (d !== 0 && Number.isFinite(d)) out.set(mk, d);
    }
    prev = cum;
  }
  return out;
}

function aggregateUnoCertCuotasByPeriod(rows: AfpCertMovementRow[]): Map<string, { cuotas: number; monto: number }> {
  const m = new Map<string, { cuotas: number; monto: number }>();
  for (const r of rows) {
    const a = m.get(r.periodYm) ?? { cuotas: 0, monto: 0 };
    a.cuotas += r.cuotasDelta;
    a.monto += r.montoClp;
    m.set(r.periodYm, a);
  }
  return m;
}

export type ModeloPriorCuotasResult = {
  delta: number;
  lines: string[];
};

/**
 * Reconcile AFP Modelo cotizaciones (pre / parallel UNO) vs UNO movimientos certificate by calendar **período**
 * and Table 1-3 **dep_afp** month deltas (CLP). Produces a single **extra cuotas** total to insert as an opening
 * adjustment so Σ cuotas tracks the fund website when Modelo rows were missing from UNO-only cert history.
 */
export function computeModeloVersusUnoPriorCuotasDelta(opts: {
  modeloRows: AfpModeloCotizacionRow[];
  unoCertText: string;
  unoCertSourceFileName: string;
  depAfpDeltaByMk: Map<MonthKey, number>;
  /** First calendar month where UNO cert is treated as authoritative for overlap (default 2017-07). */
  firstUnoAuthoritativeMk?: MonthKey;
  /** Ignore Modelo rows after this período (default 2018-08). */
  modeloCertMaxMk?: MonthKey;
}): ModeloPriorCuotasResult {
  const firstUno = opts.firstUnoAuthoritativeMk ?? "2017-07";
  const modeloMax = opts.modeloCertMaxMk ?? "2018-08";
  const lines: string[] = [];

  const modeloAgg = aggregateModeloCuotasAndMontoByPeriod(opts.modeloRows);
  const { rows: unoRows } = parseAfpCertificadoBody(opts.unoCertText, opts.unoCertSourceFileName);
  const unoAgg = aggregateUnoCertCuotasByPeriod(unoRows);

  let delta = 0;
  const keys = [...modeloAgg.keys()].filter((k) => k <= modeloMax).sort();
  for (const mk of keys) {
    const mod = modeloAgg.get(mk)!;
    const uno = unoAgg.get(mk) ?? { cuotas: 0, monto: 0 };
    const excelDelta = opts.depAfpDeltaByMk.get(mk) ?? 0;
    const absExcel = Math.abs(excelDelta);
    const absMod = Math.abs(mod.monto);

    if (mk < firstUno) continue;
    const tol = Math.max(1200, 0.12 * Math.max(absMod, absExcel || absMod));
    const montoOk = absExcel > 0 && absMod > 0 && Math.abs(absMod - absExcel) <= tol;
    if (!montoOk) continue;
    const take = Math.max(0, mod.cuotas - uno.cuotas);
    if (take <= 1e-6) continue;
    lines.push(
      `${mk}: modelo=${mod.cuotas.toFixed(4)} uno=${uno.cuotas.toFixed(4)} montoΔ≈excel ` +
        `(mod ${Math.round(mod.monto)} vs |excel| ${Math.round(absExcel)}) → +${take.toFixed(4)}`
    );
    delta += take;
  }

  delta = Math.round(delta * 100) / 100;
  return { delta, lines };
}

export function tryReadModeloCotizacionesRows(cfraserDir: string): AfpModeloCotizacionRow[] {
  const p = path.join(cfraserDir, "afp-modelo-certificado-cotizaciones.csv");
  if (!fs.existsSync(p)) return [];
  const raw = fs.readFileSync(p, "utf8").replace(/^\uFEFF/, "").trim();
  if (!raw) return [];
  return parseAfpModeloCotizacionesCsv(raw);
}

/** Optional `cfraser/afp-modelo-cuotas-supplement.txt`: one line with extra cuotas (e.g. website − auto gap). */
export function readOptionalAfpModeloCuotasSupplement(cfraserDir: string): number {
  const p = path.join(cfraserDir, "afp-modelo-cuotas-supplement.txt");
  if (!fs.existsSync(p)) return 0;
  const line = fs.readFileSync(p, "utf8").replace(/^\uFEFF/, "").trim().split(/\r?\n/)[0] ?? "";
  const n = parseDecimalComma(line.trim()) ?? 0;
  return Number.isFinite(n) && n > 0 ? n : 0;
}

export function tryReadModeloAntecedentesSnapshot(cfraserDir: string): AfpModeloAntecedentesSnapshot | null {
  const p = path.join(cfraserDir, "afp-modelo-antecedentes.csv");
  if (!fs.existsSync(p)) return null;
  const raw = fs.readFileSync(p, "utf8").replace(/^\uFEFF/, "").trim();
  if (!raw) return null;
  return parseAfpModeloAntecedentesCsv(raw);
}
