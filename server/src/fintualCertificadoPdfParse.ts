/**
 * Parse Fintual “CERTIFICADO DE TRANSACCIONES” PDF text (`pdftotext -layout`).
 */
import {
  fintualCertGoalIdFromInvestmentName,
  FINTUAL_CERT_V2_GOAL_IDS,
} from "./fintualCertV2.js";

export type FintualCertificadoPdfRow = {
  fecha: string;
  id_inversión: string;
  nombre_inversión: string;
  aporte_pesos_chilenos: string;
  rescate_pesos_chilenos: string;
  aporte_cuotas: string;
  rescate_cuotas: string;
  medio: string;
  valor_cuota: string;
  saldo_pesos_chilenos_final_día: string;
};

const FUND_RESERVA = "Very Conservative Streep";
const FUND_RISKY = "Risky Norris";

export function isFintualCertificadoTransaccionesText(body: string): boolean {
  const t = body.replace(/\s+/g, " ");
  return /CERTIFICADO\s+DE\s+TRANSACCIONES/i.test(t) && /Fintual\s+Administradora/i.test(t);
}

function normalizePdfLine(line: string): string {
  return line.replace(/\f/g, " ").replace(/\s+/g, " ").trim();
}

function parseDataLine(line: string): Omit<FintualCertificadoPdfRow, "id_inversión"> | null {
  const norm = normalizePdfLine(line);
  const dateM = /^(\d{1,2}\/\d{1,2}\/\d{4})\s+(.+)$/.exec(norm);
  if (!dateM) return null;

  const fecha = dateM[1]!;
  let rest = dateM[2]!;

  let invName: string;
  if (rest.includes(FUND_RESERVA)) {
    const idx = rest.indexOf(FUND_RESERVA);
    invName = rest.slice(0, idx).trim();
    rest = rest.slice(idx + FUND_RESERVA.length);
  } else if (rest.includes(FUND_RISKY)) {
    const idx = rest.indexOf(FUND_RISKY);
    invName = rest.slice(0, idx).trim();
    rest = rest.slice(idx + FUND_RISKY.length);
  } else {
    return null;
  }

  const tailRe =
    /^\s*(A|APV)\s+([\d.,]+|0)\s+([\d.,]+|0)\s+([\d.,]+)\s+([\d.,]+)\s+([\d$.,\s]+|0)\s+([\d$.,\s]+|0)\s+(.+?)\s+(\$[\d.,]+)\s*$/;
  const tailM = tailRe.exec(rest);
  if (!tailM) return null;

  const [, , aporteCuotasRaw, rescateCuotasRaw, valorCuotaRaw, , aportePesosRaw, rescatePesosRaw, medio, saldoFinalRaw] =
    tailM;

  return {
    fecha,
    nombre_inversión: invName,
    aporte_cuotas: aporteCuotasRaw!.trim(),
    rescate_cuotas: rescateCuotasRaw!.trim(),
    valor_cuota: valorCuotaRaw!.trim(),
    aporte_pesos_chilenos: aportePesosRaw!.trim(),
    rescate_pesos_chilenos: rescatePesosRaw!.trim(),
    medio: medio!.trim(),
    saldo_pesos_chilenos_final_día: saldoFinalRaw!.trim(),
  };
}

export function parseFintualCertificadoPdfText(body: string): FintualCertificadoPdfRow[] {
  const lines = body.split(/\r?\n/);
  const out: FintualCertificadoPdfRow[] = [];

  for (const raw of lines) {
    const line = normalizePdfLine(raw);
    if (!line || !/^\d{1,2}\/\d{1,2}\/\d{4}\s/.test(line)) continue;
    const row = parseDataLine(line);
    if (!row) continue;
    const goalId = fintualCertGoalIdFromInvestmentName(row.nombre_inversión);
    if (!goalId || !FINTUAL_CERT_V2_GOAL_IDS[goalId]) continue;
    out.push({
      ...row,
      id_inversión: goalId,
    });
  }

  return out;
}

const CSV_HEADER =
  "fecha,id_inversión,nombre_inversión,aporte_pesos_chilenos,rescate_pesos_chilenos,aporte_cuotas,rescate_cuotas,medio,valor_cuota,saldo_pesos_chilenos_final_día";

function csvEscape(v: string): string {
  if (/[",\n\r]/.test(v)) return `"${v.replace(/"/g, '""')}"`;
  return v;
}

export function fintualCertificadoPdfRowsToCsv(rows: FintualCertificadoPdfRow[]): string {
  const lines = [CSV_HEADER];
  for (const r of rows) {
    lines.push(
      [
        r.fecha,
        r.id_inversión,
        r.nombre_inversión,
        r.aporte_pesos_chilenos,
        r.rescate_pesos_chilenos,
        r.aporte_cuotas,
        r.rescate_cuotas,
        r.medio,
        r.valor_cuota,
        r.saldo_pesos_chilenos_final_día,
      ]
        .map(csvEscape)
        .join(",")
    );
  }
  return `${lines.join("\n")}\n`;
}
