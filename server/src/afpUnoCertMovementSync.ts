/**
 * Apply AFP Uno certificate rows to `import:excel` AFP cumulative movements:
 * set `movements.units_delta` from certificate **cuotas** (no CLP÷valor-cuota imputation).
 * Supports **CERTIFICADO DE MOVIMIENTOS** (CSV / `pdftotext`) and legacy **CERTIFICADO COTIZACIONES** text.
 */
import { db } from "./db.js";
import { AFP_UNO_CUOTA_SERIES_KEY, ymdFromDdMmYyyy } from "./afpQuetalmiApi.js";
import { parseAfpCertificadoBody } from "./afpUnoCertMovimientosParse.js";
import type { AfpCertMovementRow } from "./afpUnoCertParse.js";
import { aggregateAfpCertCuotasByPeriodForTable1 } from "./afpUnoCertTable1Aggregation.js";

type Agg = { monto: number; cuotas: number; rows: AfpCertMovementRow[] };

function movementMonthKey(occurredOn: string): string | null {
  const d = /^(\d{4}-\d{2})-\d{2}$/.exec(occurredOn.trim());
  return d ? d[1]! : null;
}

/** Prior cert-sync suffix so re-runs (script or import) stay idempotent. */
const CERT_NOTE_CHUNK_RE =
  /\|afp-cert:period=\d{4}-\d{2}\|cuotas=[^|]+\|cert_monto_alloc=[^|]+/g;

function stripPriorCertNoteChunks(note: string | null): string {
  return (note ?? "").replace(CERT_NOTE_CHUNK_RE, "");
}

export type ApplyAfpUnoCertificadoCuotasResult = {
  matched: number;
  warned: number;
  /** Rows upserted into `fund_unit_daily` when `seedFundUnitDaily` and not `dryRun`. */
  fundUnitSeeded: number;
  /** Rows that would be seeded in a dry run. */
  fundUnitWouldSeed: number;
};

export function applyAfpUnoCertificadoCuotasToMovements(opts: {
  accountId: number;
  certText: string;
  /** Original filename (e.g. `.csv`) selects movimientos CSV path. */
  certSourceFileName?: string;
  dryRun: boolean;
  seedFundUnitDaily: boolean;
}): ApplyAfpUnoCertificadoCuotasResult {
  const { rows: parsed, isMovimientos } = parseAfpCertificadoBody(opts.certText, opts.certSourceFileName);
  if (parsed.length === 0) {
    return { matched: 0, warned: 0, fundUnitSeeded: 0, fundUnitWouldSeed: 0 };
  }

  const byPeriod = aggregateAfpCertCuotasByPeriodForTable1(parsed);

  const movs = db
    .prepare(
      `SELECT id, amount_clp, occurred_on, note, units_delta
       FROM movements
       WHERE account_id = ?
         AND note LIKE '%Table1-3|AFP%'
       ORDER BY occurred_on ASC, id ASC`
    )
    .all(opts.accountId) as {
    id: number;
    amount_clp: number;
    occurred_on: string;
    note: string | null;
    units_delta: number | null;
  }[];

  const byMk = new Map<string, typeof movs>();
  for (const mv of movs) {
    const mk = movementMonthKey(mv.occurred_on);
    if (!mk) continue;
    const arr = byMk.get(mk) ?? [];
    arr.push(mv);
    byMk.set(mk, arr);
  }

  const updMov = db.prepare(`UPDATE movements SET units_delta = ?, note = ? WHERE id = ?`);
  const insFu = db.prepare(
    `INSERT INTO fund_unit_daily (series_key, day, unit_value_clp, note) VALUES (?,?,?,?)
     ON CONFLICT(series_key, day) DO UPDATE SET unit_value_clp = excluded.unit_value_clp, note = excluded.note`
  );

  let matched = 0;
  let warned = 0;

  for (const [mk, list] of byMk) {
    const agg = byPeriod.get(mk);
    if (!agg) {
      warned += list.length;
      continue;
    }
    const totalAbs = list.reduce((s, m) => s + Math.abs(m.amount_clp), 0);
    for (const mv of list) {
      const share = totalAbs > 0 ? Math.abs(mv.amount_clp) / totalAbs : 1 / list.length;
      const cuotasPart = agg.cuotas * share;
      const montoPart = agg.monto * share;
      const diff = Math.abs(mv.amount_clp - montoPart);
      const tol = Math.max(150, 0.04 * Math.max(Math.abs(mv.amount_clp), montoPart));
      if (diff > tol) {
        warned += 1;
      }
      const noteExtra = `|afp-cert:period=${mk}|cuotas=${cuotasPart.toFixed(6)}|cert_monto_alloc=${montoPart.toFixed(2)}`;
      const nextNote = stripPriorCertNoteChunks(mv.note) + noteExtra;
      if (!opts.dryRun) {
        updMov.run(cuotasPart, nextNote, mv.id);
      }
      matched += 1;
    }
  }

  for (const p of byPeriod.keys()) {
    if (!byMk.has(p)) {
      warned += 1;
    }
  }

  if (matched === 0 && movs.length > 0 && parsed.length > 0) {
    const mKeys = [...byMk.keys()].sort();
    const pKeys = [...byPeriod.keys()].sort();
    console.warn(
      `applyAfpUnoCertificadoCuotasToMovements: matched=0 with ${movs.length} AFP cumulative movement(s) and ${parsed.length} cert row(s). ` +
        `Movement months (sample): ${mKeys.slice(0, 8).join(", ") || "—"}. Cert periods (sample): ${pKeys.slice(0, 8).join(", ") || "—"}. ` +
        `Check CFRASER_CSV_DIR / cert file vs Excel months, or IMPORT_MAX_MONTH.`
    );
  }

  let fundUnitSeeded = 0;
  let fundUnitWouldSeed = 0;
  if (opts.seedFundUnitDaily && !isMovimientos) {
    for (const r of parsed) {
      const day = ymdFromDdMmYyyy(r.fechaCaja);
      if (!day || r.cuotasDelta <= 0) continue;
      const vu = r.montoClp / r.cuotasDelta;
      if (!Number.isFinite(vu) || vu <= 0) continue;
      const vRounded = Math.round(vu * 10000) / 10000;
      fundUnitWouldSeed += 1;
      if (!opts.dryRun) {
        insFu.run(AFP_UNO_CUOTA_SERIES_KEY, day, vRounded, "afp-cert:monto/cuotas_delta");
        fundUnitSeeded += 1;
      }
    }
  }

  return { matched, warned, fundUnitSeeded, fundUnitWouldSeed };
}
