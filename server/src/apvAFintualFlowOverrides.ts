import fs from "node:fs";
import path from "node:path";
import {
  DEPOSIT_FLOW_KIND_PERSONAL,
  DEPOSIT_FLOW_KIND_STATE,
  DEPOSIT_FLOW_KIND_TRASPASO,
  depositFlowKindFromFintualMedio,
  isFintualBonificacionDelEstadoMedio,
  isFintualTraspasoBonificacionOtraInstitucion,
  type DepositFlowKind,
} from "./depositFlowKind.js";
import { resolveCfraserCsvDir } from "./cfraserPaths.js";

export const APV_A_ACCOUNT_NOTE = "import:excel|key=apv_a";
const OVERRIDE_FILENAME = "apv-a-fintual-flow-overrides.csv";

const VALID_FLOW_KINDS = new Set<DepositFlowKind>([
  DEPOSIT_FLOW_KIND_PERSONAL,
  DEPOSIT_FLOW_KIND_STATE,
  DEPOSIT_FLOW_KIND_TRASPASO,
]);

export type ApvAFlowOverrideRow = {
  occurred_on: string;
  amount_clp: number | null;
  flow_kind: DepositFlowKind;
  comment: string | null;
};

let overrideRows: ApvAFlowOverrideRow[] | null = null;

function parseOverrideAmount(raw: string): number | null {
  const s = raw.trim();
  if (!s) return null;
  const n = Number(s.replace(/\./g, "").replace(/,/g, "."));
  return Number.isFinite(n) ? n : null;
}

export function loadApvAFintualFlowOverrides(cfraserDir?: string): ApvAFlowOverrideRow[] {
  if (overrideRows) return overrideRows;
  const dir = cfraserDir ?? resolveCfraserCsvDir();
  const fp = path.join(dir, OVERRIDE_FILENAME);
  if (!fs.existsSync(fp)) {
    overrideRows = [];
    return overrideRows;
  }
  const text = fs.readFileSync(fp, "utf8");
  const rows: ApvAFlowOverrideRow[] = [];
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const parts = t.split(";").map((p) => p.trim());
    if (parts.length < 3) continue;
    const occurred_on = parts[0]!;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(occurred_on)) continue;
    const amount_clp = parseOverrideAmount(parts[1] ?? "");
    const fk = parts[2]! as DepositFlowKind;
    if (!VALID_FLOW_KINDS.has(fk)) continue;
    rows.push({
      occurred_on,
      amount_clp,
      flow_kind: fk,
      comment: parts[3] ?? null,
    });
  }
  overrideRows = rows;
  return rows;
}

export function reloadApvAFintualFlowOverrides(): void {
  overrideRows = null;
}

export function isApvAAccountNote(notes: string | null | undefined): boolean {
  return notes === APV_A_ACCOUNT_NOTE;
}

export function apvAFlowKindOverride(
  occurred_on: string,
  amount_clp: number,
  cfraserDir?: string
): DepositFlowKind | null {
  const rows = loadApvAFintualFlowOverrides(cfraserDir);
  let dateOnly: DepositFlowKind | null = null;
  for (const r of rows) {
    if (r.occurred_on !== occurred_on) continue;
    if (r.amount_clp == null) {
      dateOnly = r.flow_kind;
      continue;
    }
    if (Math.abs(r.amount_clp - amount_clp) < 1) return r.flow_kind;
  }
  return dateOnly;
}

/**
 * Classify APV-a Fintual flows: CSV overrides, then medio/tipo labels, then default medio rules.
 */
export function depositFlowKindForApvAFintualRow(
  occurred_on: string,
  amount_clp: number,
  medio: string,
  note: string | null | undefined,
  cfraserDir?: string
): DepositFlowKind {
  const overridden = apvAFlowKindOverride(occurred_on, amount_clp, cfraserDir);
  if (overridden) return overridden;

  const fromNote = note?.match(
    /\|flow_kind=(deposit_clp|aporte_estatal_clp|traspaso_bonificacion_clp)(?:\||$)/
  )?.[1] as DepositFlowKind | undefined;
  if (fromNote) return fromNote;

  const medioAndComment = [medio, note ?? ""].filter(Boolean).join(" ");
  if (isFintualTraspasoBonificacionOtraInstitucion(medioAndComment)) {
    return DEPOSIT_FLOW_KIND_TRASPASO;
  }
  if (isFintualBonificacionDelEstadoMedio(medio)) return DEPOSIT_FLOW_KIND_STATE;

  return depositFlowKindFromFintualMedio(medio);
}
