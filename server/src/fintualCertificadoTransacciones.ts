import fs from "node:fs";
import path from "node:path";
import type { Statement } from "better-sqlite3";
import { readCommaCsvRecords } from "./ccParsedCommaCsv.js";
import { type DepositFlowKind, depositFlowKindFromFintualMedio } from "./depositFlowKind.js";

/** Chilean Numbers / Fintual CSV: thousands `.`, decimals `,`, optional `$`. */
export function parseFintualCertMoneyCell(raw: string | undefined): number | null {
  if (raw == null) return null;
  const s = String(raw).trim();
  if (!s) return null;
  const neg = s.includes("(") && s.includes(")");
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

export function parseDdMmYyyyToIso(fecha: string): string | null {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(String(fecha ?? "").trim());
  if (!m) return null;
  const d = Number(m[1]);
  const mo = Number(m[2]);
  const y = Number(m[3]);
  if (!Number.isFinite(d) || !Number.isFinite(mo) || !Number.isFinite(y)) return null;
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  return `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

export type FintualCertificadoAccounts = {
  fondo_reserva: number;
  fintual_rn: number;
  apv_a: number;
  apv_b: number;
};

export type FintualCertificadoApplyResult = {
  movementsInserted: number;
  /** Earliest calendar month (`YYYY-MM`) with any peso/cuotas flow on Fintual APV-a in the certificate. */
  apvACutMonth: string | null;
  /** Earliest transaction date for Fintual APV-a in the certificate. */
  apvAFirstFlowYmd: string | null;
  /** Net CLP (aportes − rescates) for Fintual APV-a in `apvACutMonth` from the certificate. */
  apvAFirstMonthNetClp: number;
};

const NOTE_PREFIX = "import:excel|fintual-certificado";

export type CertificadoAccountResolver = (importNote: string | null) => number | undefined;

function accountIdForImportNote(note: string | null, acc: FintualCertificadoAccounts): number | undefined {
  if (!note) return undefined;
  switch (note) {
    case "import:excel|key=fondo_reserva":
      return acc.fondo_reserva;
    case "import:excel|key=fintual_rn":
      return acc.fintual_rn;
    case "import:excel|key=apv_a":
      return acc.apv_a;
    case "import:excel|key=apv_b":
      return acc.apv_b;
    default:
      return undefined;
  }
}

export function legacyCertificadoAccountResolver(
  acc: FintualCertificadoAccounts
): CertificadoAccountResolver {
  return (note) => accountIdForImportNote(note, acc);
}

export type GoalToImportNote = (goalId: string, investmentName: string) => string | null;

type Agg = {
  ymd: string;
  goalId: string;
  name: string;
  flowKind: DepositFlowKind;
  clpNet: number;
  cuotasNet: number;
  medios: Set<string>;
  valorCuotaHint: number | null;
};

export type FintualCertificadoAggregateScan = {
  sortedAggregates: Agg[];
  apvACutMonth: string | null;
  apvAFirstFlowYmd: string | null;
  apvAFirstMonthNetClp: number;
  /** Latest certificate `Saldo Pesos Chilenos Final Día` per `YYYY-MM` for Reserva rows (Fintual SoT valuations). */
  reservaSaldoClpByMonthKey: Map<string, number>;
};

/**
 * Parses the certificate and emits one movement per CSV row with net flow (no same-day merge).
 * Does not touch the database.
 */
export function aggregateFintualCertificado(
  csvPath: string,
  maxMonth: string,
  matchGoal: GoalToImportNote
): FintualCertificadoAggregateScan | null {
  if (!fs.existsSync(csvPath)) return null;

  const rows = readCommaCsvRecords(csvPath);

  const reservaSaldoBestByMk = new Map<string, { lastYmd: string; saldo: number }>();
  for (const r of rows) {
    const fecha = String(r.fecha ?? "").trim();
    const ymd = parseDdMmYyyyToIso(fecha);
    if (!ymd) continue;
    const mk = ymd.slice(0, 7);
    if (mk > maxMonth) continue;
    const goalId = String(r.id_inversión ?? r.id_inversion ?? "").trim();
    if (!goalId) continue;
    const nombre = String(r.nombre_inversión ?? r.nombre_inversion ?? "").trim();
    if (matchGoal(goalId, nombre) !== "import:excel|key=fondo_reserva") continue;
    const saldoRaw =
      r.saldo_pesos_chilenos_final_dia ?? r.saldo_pesos_chilenos_final_día ?? r.saldo_pesos_final_dia ?? "";
    const saldo = parseFintualCertMoneyCell(String(saldoRaw));
    if (saldo == null || !Number.isFinite(saldo) || saldo <= 0) continue;
    const prev = reservaSaldoBestByMk.get(mk);
    if (!prev || ymd >= prev.lastYmd) {
      reservaSaldoBestByMk.set(mk, { lastYmd: ymd, saldo });
    }
  }
  const reservaSaldoClpByMonthKey = new Map<string, number>();
  for (const [mk, v] of reservaSaldoBestByMk) {
    reservaSaldoClpByMonthKey.set(mk, v.saldo);
  }

  const sortedAggregates: Agg[] = [];

  let apvAFirstFlowYmd: string | null = null;
  let apvACutMonth: string | null = null;

  for (const r of rows) {
    const fecha = String(r.fecha ?? "").trim();
    const ymd = parseDdMmYyyyToIso(fecha);
    if (!ymd) continue;
    const mk = ymd.slice(0, 7);
    if (mk > maxMonth) continue;

    const goalId = String(r.id_inversión ?? r.id_inversion ?? "").trim();
    if (!goalId) continue;
    const nombre = String(r.nombre_inversión ?? r.nombre_inversion ?? "").trim();
    const importNote = matchGoal(goalId, nombre);
    if (!importNote) continue;

    const aporteClp = parseFintualCertMoneyCell(r.aporte_pesos_chilenos) ?? 0;
    const rescateClp = parseFintualCertMoneyCell(r.rescate_pesos_chilenos) ?? 0;
    const aporteQ = parseFintualCertMoneyCell(r.aporte_cuotas) ?? 0;
    const rescateQ = parseFintualCertMoneyCell(r.rescate_cuotas) ?? 0;
    const clpNet = aporteClp - rescateClp;
    const cuotasNet = aporteQ - rescateQ;
    if (clpNet === 0 && cuotasNet === 0) continue;

    const medio = String(r.medio ?? "").trim();
    const flowKind: DepositFlowKind = depositFlowKindFromFintualMedio(medio);
    const medios = new Set<string>();
    if (medio) medios.add(medio);
    const vqRow = parseFintualCertMoneyCell(r.valor_cuota);
    sortedAggregates.push({
      ymd,
      goalId,
      name: nombre,
      flowKind,
      clpNet,
      cuotasNet,
      medios,
      valorCuotaHint: vqRow != null && vqRow > 0 ? vqRow : null,
    });

    if (importNote === "import:excel|key=apv_a") {
      if (apvAFirstFlowYmd == null || ymd < apvAFirstFlowYmd) apvAFirstFlowYmd = ymd;
      const cm = ymd.slice(0, 7);
      if (apvACutMonth == null || cm < apvACutMonth) apvACutMonth = cm;
    }
  }

  let apvAFirstMonthNetClp = 0;
  if (apvACutMonth) {
    for (const a of sortedAggregates) {
      const note = matchGoal(a.goalId, a.name);
      if (note !== "import:excel|key=apv_a") continue;
      if (a.ymd.slice(0, 7) !== apvACutMonth) continue;
      apvAFirstMonthNetClp += a.clpNet;
    }
  }

  sortedAggregates.sort((x, y) => {
    const c = x.ymd.localeCompare(y.ymd);
    return c !== 0 ? c : x.goalId.localeCompare(y.goalId);
  });

  return {
    sortedAggregates,
    apvACutMonth,
    apvAFirstFlowYmd,
    apvAFirstMonthNetClp,
    reservaSaldoClpByMonthKey,
  };
}

export function insertFintualCertificadoMovementsFromAggregates(
  scan: FintualCertificadoAggregateScan,
  resolveAccountId: CertificadoAccountResolver,
  insMov: Statement<[number, number, string, string, number | null]>,
  matchGoal: GoalToImportNote,
  notePrefix: string = NOTE_PREFIX
): number {
  let movementsInserted = 0;
  for (const a of scan.sortedAggregates) {
    const importNote = matchGoal(a.goalId, a.name);
    if (!importNote) continue;
    const accountId = resolveAccountId(importNote);
    if (accountId == null) continue;

    let impliedClp = a.clpNet;
    if (impliedClp === 0 && a.cuotasNet !== 0 && a.valorCuotaHint != null) {
      impliedClp = Math.round(a.cuotasNet * a.valorCuotaHint);
    }
    if (impliedClp === 0) continue;

    const medio = [...a.medios].sort().join("; ");
    const note = `${notePrefix}|goal=${a.goalId}|day=${a.ymd}|flow_kind=${a.flowKind}${medio ? `|medio=${medio}` : ""}`;
    const ud = a.cuotasNet !== 0 ? a.cuotasNet : null;
    insMov.run(accountId, impliedClp, a.ymd, note, ud);
    movementsInserted += 1;
  }
  return movementsInserted;
}

export function applyFintualCertificadoMovements(
  csvPath: string,
  acc: FintualCertificadoAccounts,
  maxMonth: string,
  insMov: Statement<[number, number, string, string, number | null]>,
  matchGoal: GoalToImportNote
): FintualCertificadoApplyResult {
  const scan = aggregateFintualCertificado(csvPath, maxMonth, matchGoal);
  if (!scan) {
    return { movementsInserted: 0, apvACutMonth: null, apvAFirstFlowYmd: null, apvAFirstMonthNetClp: 0 };
  }
  const movementsInserted = insertFintualCertificadoMovementsFromAggregates(
    scan,
    legacyCertificadoAccountResolver(acc),
    insMov,
    matchGoal
  );
  return {
    movementsInserted,
    apvACutMonth: scan.apvACutMonth,
    apvAFirstFlowYmd: scan.apvAFirstFlowYmd,
    apvAFirstMonthNetClp: scan.apvAFirstMonthNetClp,
  };
}

export function resolveFintualCertificadoCsvPath(cfraserDir: string): string | null {
  const env = process.env.FINTUAL_CERTIFICADO_CSV?.trim();
  if (env) {
    const abs = path.resolve(env);
    if (fs.existsSync(abs)) return abs;
  }
  const p = path.join(cfraserDir, "fintual-certificado-de-transacciones.csv");
  if (fs.existsSync(p)) return p;
  return null;
}
