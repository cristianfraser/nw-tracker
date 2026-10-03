/**
 * The Fintual «certificado de transacciones» CSV (installed by `certificadoInbox.ts` as
 * `cfraser/fintual-certificado-de-transacciones.csv`) → `fund_account.transactions`: every row
 * that moves pesos or cuotas, as printed. The certificate's daily balance rows are not sent.
 */
import fs from "node:fs";
import path from "node:path";
import type { FundAccountTransactionsPayload, FundTransaction } from "nw-tracker-contracts";
import { readCommaCsvRecords } from "../formats/commaCsv.js";
import { parseDdMmYyToIso } from "../formats/ddMmYy.js";
import { resolveCfraserDir } from "../paths.js";
import { FINTUAL_CERTIFICADO_CANONICAL_NAME } from "./certificadoInbox.js";

/** Chilean Numbers / Fintual CSV: thousands `.`, decimals `,`, optional `$`. */
export function parseFintualCertMoneyCell(raw: string | undefined): number | null {
  if (raw == null) return null;
  const s = String(raw).trim();
  if (!s) return null;
  const neg = s.includes("(") && s.includes(")");
  const t = s
    .replace(/^﻿/, "")
    .replace(/US\$/gi, "")
    .replace(/[$\sUF   ]/gi, "")
    .replace(/\./g, "")
    .replace(/,/g, ".")
    .replace(/[()]/g, "");
  const n = Number(t);
  if (!Number.isFinite(n)) return null;
  return neg ? -n : n;
}

/** The installed certificado, or `FINTUAL_CERTIFICADO_CSV` when set; null when neither exists. */
export function resolveFintualCertificadoCsvPath(cfraserDir = resolveCfraserDir()): string | null {
  const env = process.env.FINTUAL_CERTIFICADO_CSV?.trim();
  if (env) {
    const abs = path.resolve(env);
    if (fs.existsSync(abs)) return abs;
  }
  const p = path.join(cfraserDir, FINTUAL_CERTIFICADO_CANONICAL_NAME);
  return fs.existsSync(p) ? p : null;
}

/** The rows of the CSV that move pesos or cuotas. A row without a date or an investment id is not a transaction. */
export function readFintualCertificadoTransactions(csvPath: string): FundTransaction[] {
  const out: FundTransaction[] = [];
  for (const r of readCommaCsvRecords(csvPath)) {
    const date = parseDdMmYyToIso(String(r.fecha ?? "").trim());
    if (!date) continue;
    const id = String(r.id_inversión ?? r.id_inversion ?? "").trim();
    if (!id) continue;
    const clpIn = parseFintualCertMoneyCell(r.aporte_pesos_chilenos) ?? 0;
    const clpOut = parseFintualCertMoneyCell(r.rescate_pesos_chilenos) ?? 0;
    const unitsIn = parseFintualCertMoneyCell(r.aporte_cuotas) ?? 0;
    const unitsOut = parseFintualCertMoneyCell(r.rescate_cuotas) ?? 0;
    if (clpIn === 0 && clpOut === 0 && unitsIn === 0 && unitsOut === 0) continue;
    const vq = parseFintualCertMoneyCell(r.valor_cuota);
    const medio = String(r.medio ?? "").trim();
    out.push({
      date,
      investment: { id, name: String(r.nombre_inversión ?? r.nombre_inversion ?? "").trim() },
      medio: medio || null,
      clp_in: clpIn,
      clp_out: clpOut,
      units_in: unitsIn,
      units_out: unitsOut,
      unit_value: vq != null && vq > 0 ? vq : null,
    });
  }
  return out;
}

export function fundAccountTransactionsPayload(
  csvPath: string,
  opts: { apply: boolean; maxMonth: string | null }
): FundAccountTransactionsPayload {
  return {
    apply: opts.apply,
    provider: "fintual",
    document: path.basename(csvPath),
    max_month: opts.maxMonth,
    transactions: readFintualCertificadoTransactions(csvPath),
  };
}
