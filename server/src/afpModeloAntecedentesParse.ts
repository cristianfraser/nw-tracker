/**
 * AFP Modelo “CERTIFICADO DE ANTECEDENTES PREVISIONALES” and “COMPROBANTE DE TRASPASO”.
 */
import { parseClpChilean, parseDecimalComma } from "./afpUnoCertParse.js";

export type AfpModeloAntecedentesSnapshot = {
  rut: string;
  fechaAfiliacionMmYyyy: string | null;
  fechaIngresoSistemaDdMmYyyy: string | null;
  /** Obligatoria / NORMAL row. */
  saldoClp: number;
  cuotas: number;
  valorCuotaClp: number;
  valorCuotaDayDdMmYyyy: string | null;
  fondo: string;
};

export type AfpModeloTraspasoRecord = {
  rut: string;
  fechaSolicitudDdMmYyyy: string | null;
  afpOrigen: string;
  cuentaOrigen: string;
  folio: string | null;
  materializacionDdMmYyyy: string | null;
  fondoDestino: string | null;
};

export function isAfpModeloAntecedentesCertText(raw: string): boolean {
  const u = raw.slice(0, 8000).toUpperCase();
  return u.includes("ANTECEDENTES PREVISIONALES") && u.includes("A.F.P. MODELO");
}

export function isAfpModeloTraspasoCertText(raw: string): boolean {
  const u = raw.slice(0, 8000).toUpperCase();
  return u.includes("COMPROBANTE DE TRASPASO") && u.includes("CUENTAS TRASPASADAS");
}

function ddMmYyyyToYmd(ddMmYyyy: string): string | null {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(ddMmYyyy.trim());
  if (!m) return null;
  return `${m[3]}-${m[2]}-${m[1]}`;
}

function mmDashYyyyToYm(mmDashYyyy: string): string | null {
  const m = /^(\d{2})-(\d{4})$/.exec(mmDashYyyy.trim());
  if (!m) return null;
  return `${m[2]}-${m[1]}`;
}

export function parseAfpModeloAntecedentesText(raw: string): AfpModeloAntecedentesSnapshot | null {
  const t = raw.replace(/\r\n/g, "\n");
  const rutM = /R\.U\.T\.\s*:\s*([\d.]+-[\dkK])/i.exec(t);
  const afilM = /Fecha Afiliación\s*:\s*(\d{2}-\d{4})/i.exec(t);
  const ingM = /Fecha Ingreso al Sistema\s*:\s*(\d{2}-\d{2}-\d{4})/i.exec(t);
  const rowM =
    /Obligatoria\s+NORMAL\s+([\d.]+)\s+([\d.,]+)\s+[\d.,]+\s+([\d.,]+)\s+(\d{2}-\d{2}-\d{4})\s+([A-E])/i.exec(
      t.replace(/\s+/g, " ")
    );
  if (!rowM) return null;
  const saldoClp = parseClpChilean(rowM[1]!) ?? 0;
  const cuotas = parseDecimalComma(rowM[2]!) ?? 0;
  const valorCuotaClp = parseClpChilean(rowM[3]!) ?? 0;
  if (cuotas <= 0 || valorCuotaClp < 1000) return null;
  return {
    rut: rutM?.[1] ?? "",
    fechaAfiliacionMmYyyy: afilM?.[1] ?? null,
    fechaIngresoSistemaDdMmYyyy: ingM?.[1] ?? null,
    saldoClp,
    cuotas,
    valorCuotaClp,
    valorCuotaDayDdMmYyyy: rowM[4]!,
    fondo: rowM[5]!.toUpperCase(),
  };
}

export function parseAfpModeloTraspasoText(raw: string): AfpModeloTraspasoRecord | null {
  const t = raw.replace(/\r\n/g, "\n");
  const rutM = /RUT:\s*([\d.]+-[\dkK])/i.exec(t);
  const solM = /Fecha Solicitud:\s*(\d{2}-\d{2}-\d{4})/i.exec(t);
  const folioM = /(\d{6,8})\s+([A-Z][\w\s.]+?)\s+CUENTA/i.exec(t.replace(/\s+/g, " "));
  const matM = /(\d{2}-\d{2}-\d{4})\s*$/m.exec(
    t
      .split("CUENTAS TRASPASADAS")[1]
      ?.split("TIPOS DE FONDOS")[0]
      ?.trim() ?? ""
  );
  if (!folioM) return null;
  return {
    rut: rutM?.[1] ?? "",
    fechaSolicitudDdMmYyyy: solM?.[1] ?? null,
    folio: folioM[1]!,
    afpOrigen: folioM[2]!.trim(),
    cuentaOrigen: "CUENTA OBLIGATORIA",
    materializacionDdMmYyyy: matM?.[1] ?? null,
    fondoDestino: "A",
  };
}

export function antecedentesSnapshotToCsv(s: AfpModeloAntecedentesSnapshot): string {
  const header =
    "rut;fecha_afiliacion_mm_yyyy;fecha_ingreso_sistema;cuotas_obligatoria;saldo_clp;valor_cuota_clp;valor_cuota_day;fondo";
  const ing = s.fechaIngresoSistemaDdMmYyyy ?? "";
  const day = s.valorCuotaDayDdMmYyyy ?? "";
  return (
    [
      header,
      [
        s.rut,
        s.fechaAfiliacionMmYyyy ?? "",
        ing,
        String(s.cuotas).replace(".", ","),
        String(Math.round(s.saldoClp)),
        String(s.valorCuotaClp).replace(".", ","),
        day,
        s.fondo,
      ].join(";"),
    ].join("\n") + "\n"
  );
}

export function traspasoRecordToCsv(r: AfpModeloTraspasoRecord): string {
  const header =
    "rut;fecha_solicitud;afp_origen;cuenta_origen;folio;materializacion;fondo_destino";
  return (
    [
      header,
      [
        r.rut,
        r.fechaSolicitudDdMmYyyy ?? "",
        r.afpOrigen,
        r.cuentaOrigen,
        r.folio ?? "",
        r.materializacionDdMmYyyy ?? "",
        r.fondoDestino ?? "A",
      ].join(";"),
    ].join("\n") + "\n"
  );
}

export function parseAfpModeloAntecedentesCsv(raw: string): AfpModeloAntecedentesSnapshot | null {
  const lines = raw.replace(/^\uFEFF/, "").trim().split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trim();
    if (!line || /^rut;/i.test(line)) continue;
    const cols = line.split(";");
    if (cols.length < 8) continue;
    const cuotas = parseDecimalComma(cols[3]!.trim()) ?? 0;
    const saldoClp = parseClpChilean(cols[4]!.trim()) ?? 0;
    const valorCuotaClp = parseClpChilean(cols[5]!.trim()) ?? 0;
    if (cuotas <= 0 || valorCuotaClp < 1000) continue;
    return {
      rut: cols[0]!.trim(),
      fechaAfiliacionMmYyyy: cols[1]!.trim() || null,
      fechaIngresoSistemaDdMmYyyy: cols[2]!.trim() || null,
      saldoClp,
      cuotas,
      valorCuotaClp,
      valorCuotaDayDdMmYyyy: cols[6]!.trim() || null,
      fondo: (cols[7] ?? "A").trim().toUpperCase(),
    };
  }
  return null;
}

export function antecedentesIngresoSistemaYmd(s: AfpModeloAntecedentesSnapshot): string | null {
  if (!s.fechaIngresoSistemaDdMmYyyy) return null;
  const p = s.fechaIngresoSistemaDdMmYyyy.split("-");
  if (p.length === 3) return `${p[2]}-${p[1]}-${p[0]}`;
  return ddMmYyyyToYmd(s.fechaIngresoSistemaDdMmYyyy.replace(/-/g, "/"));
}

export function antecedentesAfiliacionYm(s: AfpModeloAntecedentesSnapshot): string | null {
  return s.fechaAfiliacionMmYyyy ? mmDashYyyyToYm(s.fechaAfiliacionMmYyyy) : null;
}
