/**
 * AFP Modelo “CERTIFICADO COTIZACIONES” (pdftotext -layout) — same shape as classic AFP cotización certs:
 * período MM-YYYY, tipo, fecha caja, monto CLP, cuotas, valor cuota, RUT pagador, fondo A–E.
 */
import { parseClpChilean, parseDecimalComma, periodMmYyyyToYm } from "./afpUnoCertParse.js";

export type AfpModeloCotizacionRow = {
  periodMmYyyy: string;
  periodYm: string;
  tipoRaw: string;
  fechaCaja: string;
  montoClp: number;
  cuotas: number;
  valorCuotaClp: number;
  rutPagador: string;
  fondo: string;
};

function cleanModeloMergedBuffer(buf: string): string {
  return buf
    .replace(/\s+Página\s+\d+\s+de\s+\d[^\n]*$/i, "")
    .replace(/\s+Fecha\s+Monto\s+Valor[^\n]*$/i, "")
    .replace(/\s+Período\s+Tipo\s+de\s+Movimiento[^\n]*$/i, "")
    .replace(/\s+Caja\s+Pesos\s+Cuotas[^\n]*$/i, "")
    .trim();
}

function mergeWrappedTipoLines(raw: string): string[] {
  const lines = raw
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .split("\n")
    .map((l) => l.trimEnd());
  const out: string[] = [];
  let buf = "";
  for (const l of lines) {
    const t = l.trim();
    if (!t) continue;
    if (/^Página\s+\d+\s+de\s+\d/i.test(t)) continue;
    if (/^Fecha\s+Monto\s+Valor/i.test(t)) continue;
    if (/^Período\s+Tipo\s+de\s+Movimiento/i.test(t)) continue;
    if (/^Monto\s+Pesos\s+Cuotas/i.test(t)) continue;
    if (/^Caja\s+Pesos\s+Cuotas/i.test(t)) continue;
    if (/^\d{2}-\d{4}\s/.test(t)) {
      if (buf) {
        const c = cleanModeloMergedBuffer(buf);
        if (c) out.push(c);
      }
      buf = t.replace(/\s+/g, " ").trim();
    } else if (buf && !/^\d{2}-\d{4}\s/.test(t)) {
      buf += " " + t.replace(/\s+/g, " ").trim();
    }
  }
  if (buf) {
    const c = cleanModeloMergedBuffer(buf);
    if (c) out.push(c);
  }
  return out;
}

/**
 * One logical line after merge (period at start … fondo letter at end).
 * Example:
 * `06-2018 COTIZACION NORMAL 13/07/2018 149.871 3,67 40.855,82 76.104.664-0 A`
 */
export function parseAfpModeloCotizacionMergedLine(line: string): AfpModeloCotizacionRow | null {
  let s = line.replace(/\s+/g, " ").trim();
  s = s.replace(/\s+INDEPENDIENTE\s+TRANSF\.?\s*$/i, "").trim();
  s = s.replace(/\s+Caja\s+Pesos\s+Cuotas[^\n]*$/i, "").trim();
  s = s.replace(/\s+Página\s+\d+\s+de\s+\d[^\n]*$/i, "").trim();
  const head = /^(\d{2}-\d{4})\s+(.+?)\s+(\d{2}\/\d{2}\/\d{4})\s+/.exec(s);
  if (!head) return null;
  const periodMmYyyy = head[1]!;
  const periodYm = periodMmYyyyToYm(periodMmYyyy);
  if (!periodYm) return null;
  const tipoStart = head[2]!.trim();
  const fechaCaja = head[3]!;
  const rest = s.slice(head[0].length).trim();

  const tailRe =
    /^([\d\.,]+)\s+([\d\.,]+)\s+([\d\.,]+)\s+(\d{2}\.\d{3}\.\d{3}-[\dkK])\s+([A-E])\s*$/i;
  const tm = tailRe.exec(rest);
  if (!tm) return null;
  const montoClp = parseClpChilean(tm[1]!) ?? 0;
  const cuotas = parseDecimalComma(tm[2]!) ?? 0;
  const valorCuotaClp = parseClpChilean(tm[3]!) ?? 0;
  const rutPagador = tm[4]!;
  const fondo = tm[5]!.toUpperCase();
  const tipoRaw = tipoStart.trim();

  if (montoClp <= 0 || !Number.isFinite(cuotas) || cuotas <= 0) return null;
  if (!Number.isFinite(valorCuotaClp) || valorCuotaClp < 1000) return null;

  return {
    periodMmYyyy,
    periodYm,
    tipoRaw,
    fechaCaja,
    montoClp,
    cuotas,
    valorCuotaClp,
    rutPagador,
    fondo,
  };
}

export function isAfpModeloCotizacionesCertText(raw: string): boolean {
  const u = raw.slice(0, 8000).toUpperCase();
  return u.includes("A.F.P. MODELO") && u.includes("CERTIFICADO COTIZACIONES");
}

export function parseAfpModeloCotizacionesPdfText(raw: string): AfpModeloCotizacionRow[] {
  const merged = mergeWrappedTipoLines(raw);
  const out: AfpModeloCotizacionRow[] = [];
  for (const ln of merged) {
    const r = parseAfpModeloCotizacionMergedLine(ln);
    if (r) out.push(r);
  }
  return out;
}

export function modeloCotizacionesRowsToCsv(rows: AfpModeloCotizacionRow[]): string {
  const header =
    "period_mm_yyyy;tipo_movimiento;fecha_caja;monto_clp;cuotas;valor_cuota_clp;rut_pagador;fondo";
  const esc = (s: string) => {
    const t = String(s ?? "").replace(/"/g, '""');
    return /[;\n\r]/.test(t) ? `"${t}"` : t;
  };
  const body = rows.map((r) =>
    [
      r.periodMmYyyy,
      esc(r.tipoRaw),
      r.fechaCaja,
      String(Math.round(r.montoClp)),
      String(r.cuotas).replace(".", ","),
      String(r.valorCuotaClp).replace(".", ","),
      r.rutPagador,
      r.fondo,
    ].join(";")
  );
  return [header, ...body].join("\n") + "\n";
}

export function parseAfpModeloCotizacionesCsv(raw: string): AfpModeloCotizacionRow[] {
  const text = raw.replace(/^\uFEFF/, "").trim();
  const lines = text.split("\n");
  const out: AfpModeloCotizacionRow[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trim();
    if (!line) continue;
    const cols = line.split(";");
    if (cols.length < 8) continue;
    if (i === 0 && /^period_mm_yyyy/i.test(cols[0]!.trim())) continue;
    const [periodMmYyyy, tipoRaw, fechaCaja, montoS, cuotasS, valorS, rut, fondo] = cols;
    const periodYm = periodMmYyyyToYm(periodMmYyyy!.trim());
    if (!periodYm) continue;
    const montoClp = parseClpChilean(montoS!.trim()) ?? 0;
    const cuotas = parseDecimalComma(cuotasS!.trim()) ?? 0;
    const valorCuotaClp = parseClpChilean(valorS!.trim()) ?? 0;
    if (montoClp <= 0 || cuotas <= 0 || valorCuotaClp < 1000) continue;
    out.push({
      periodMmYyyy: periodMmYyyy!.trim(),
      periodYm,
      tipoRaw: (tipoRaw ?? "").trim(),
      fechaCaja: (fechaCaja ?? "").trim(),
      montoClp,
      cuotas,
      valorCuotaClp,
      rutPagador: (rut ?? "").trim(),
      fondo: (fondo ?? "").trim().toUpperCase(),
    });
  }
  return out;
}

export function aggregateModeloCuotasAndMontoByPeriod(rows: AfpModeloCotizacionRow[]): Map<string, { cuotas: number; monto: number }> {
  const m = new Map<string, { cuotas: number; monto: number }>();
  for (const r of rows) {
    const a = m.get(r.periodYm) ?? { cuotas: 0, monto: 0 };
    a.cuotas += r.cuotas;
    a.monto += r.montoClp;
    m.set(r.periodYm, a);
  }
  return m;
}
