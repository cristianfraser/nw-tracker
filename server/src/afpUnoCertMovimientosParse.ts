/**
 * AFP UNO “CERTIFICADO DE MOVIMIENTOS CUENTA” (layout from `pdftotext -layout` on UNO-15+ PDFs).
 * More granular than “CERTIFICADO COTIZACIONES”: signed Abono/Cargo lines → net cuotas per período.
 */
import {
  parseAfpUnoCertificadoText,
  parseClpChilean,
  parseDecimalComma,
  periodMmYyyyToYm,
  type AfpCertMovementRow,
} from "./afpUnoCertParse.js";

export type AfpMovimientoCertRow = {
  periodMmYyyy: string;
  periodYm: string;
  cargoAbono: "Cargo" | "Abono";
  codigo: string;
  tipoMovimiento: string;
  montoClpAbs: number;
  cuotasAbs: number;
  valorCuotaClp: number;
  rutEmpleador: string;
  fondo: string;
};

export function isAfpUnoMovimientosCertText(raw: string): boolean {
  const head = raw.slice(0, 6000).toUpperCase();
  return (
    head.includes("CERTIFICADO DE MOVIMIENTOS") ||
    (head.includes("TIPO DE MOVIMIENTO") && head.includes("CUENTA OBLIGATORIA"))
  );
}

function skipMovimientoHeaderLine(l: string): boolean {
  return (
    /^(Período|Certificado|AFP\s+UNO|Folio|Tipo\s+de\s+Fondo|Cotización\s+Abono|Página\s+\d)/i.test(l) ||
    /^[-_]{2,}/.test(l) ||
    /^Santiago/i.test(l) ||
    /registra\s+en\s+su/i.test(l) ||
    /^R\.U\.T\.:/i.test(l) ||
    /^DOMICILIO:/i.test(l) ||
    /^Período\s+Informado/i.test(l) ||
    /^Fecha\s+Afiliación/i.test(l)
  );
}

/** Join wrapped `pdftotext` lines into one logical row per movement. */
export function mergeMovimientoPdfLines(raw: string): string[] {
  const lines = raw
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  const out: string[] = [];
  let buf = "";
  for (const l of lines) {
    if (skipMovimientoHeaderLine(l)) continue;
    if (/^\d{2}-\d{4}\s+(Cargo|Abono)\b/i.test(l)) {
      if (buf) out.push(buf);
      buf = l.replace(/\s+/g, " ").trim();
    } else if (buf) {
      buf += " " + l.replace(/\s+/g, " ").trim();
    }
  }
  if (buf) out.push(buf);
  return out;
}

function periodYmFromMmYyyy(mmDashYyyy: string): string | null {
  return periodMmYyyyToYm(mmDashYyyy);
}

function syntheticFechaCajaFromPeriodYm(periodYm: string): string {
  const m = /^(\d{4})-(\d{2})$/.exec(periodYm.trim());
  if (!m) return "01/01/2000";
  const y = Number(m[1]);
  const mo = Number(m[2]);
  if (!Number.isFinite(y) || mo < 1 || mo > 12) return "01/01/2000";
  const d = new Date(y, mo, 0);
  const dd = String(d.getDate()).padStart(2, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  return `${dd}/${mm}/${y}`;
}

/** Six-digit movement codes (UNO) — not CLP amounts. */
function looksLikeMovementCode(tok: string): boolean {
  return /^[12]\d{5}$/.test(tok);
}

/**
 * UNO Fondo A “valor cuota” is on the order of tens of thousands of CLP. Rows with tiny bogus values (e.g. `9`)
 * come from odd **Traspaso Egreso** PDF/CSV layouts and would otherwise be parsed as huge fake “cuotas”, wiping Σ cuotas.
 */
export const AFP_UNO_MOVIMIENTOS_VALOR_CUOTA_MIN_CLP = 1_000;

/**
 * One merged movement line: from `Cargo|Abono` through RUT + fondo.
 * Right block is always: monto (CLP) · cuotas · valor cuota · rut · fondo (columns in cert).
 */
export function parseAfpUnoMovimientoMergedLine(line: string): AfpMovimientoCertRow | null {
  const s = line.replace(/\s+/g, " ").trim();
  const head = /^(\d{2}-\d{4})\s+(Cargo|Abono)\s+/i.exec(s);
  if (!head) return null;
  const periodMmYyyy = head[1]!;
  const cargoAbono = (head[2]!.charAt(0).toUpperCase() + head[2]!.slice(1).toLowerCase()) as "Cargo" | "Abono";
  const periodYm = periodYmFromMmYyyy(periodMmYyyy);
  if (!periodYm) return null;

  const rest0 = s.slice(head[0].length).trim();
  const rutRe = /(\d{2}\.\d{3}\.\d{3}-[\dkK])\s+([A-E])\s*$/i;
  const rm = rutRe.exec(rest0);
  let rutEmpleador: string;
  let fondo: string;
  let rest: string;
  if (rm) {
    rutEmpleador = rm[1]!;
    fondo = rm[2]!.toUpperCase();
    rest = rest0.slice(0, rm.index).trim();
  } else {
    const fm = /\s+([A-E])\s*$/i.exec(rest0);
    if (!fm) return null;
    fondo = fm[1]!.toUpperCase();
    rutEmpleador = "00.000.000-0";
    rest = rest0.slice(0, fm.index).trim();
  }

  const tailRe = /\s+([\d\.,]+)\s+([\d\.,]+)\s*$/;
  const tm = tailRe.exec(rest);
  if (!tm) return null;
  const cuotasStr = tm[1]!;
  const valorStr = tm[2]!;
  const middle = rest.slice(0, tm.index).trim();

  const cuotasAbs = Math.abs(parseDecimalComma(cuotasStr) ?? 0);
  const valorCuotaClp = parseClpChilean(valorStr) ?? 0;
  if (!Number.isFinite(valorCuotaClp) || valorCuotaClp < AFP_UNO_MOVIMIENTOS_VALOR_CUOTA_MIN_CLP) return null;

  let montoClpAbs: number | null = null;
  let codigo = "";
  let tipoMovimiento = middle;

  const leadMonto = /^(\d{1,3}(?:\.\d{3})+(?:,\d{2})?|\d+,\d{2}|\d{1,3}(?:\.\d{3})+)\s+(.*)$/i.exec(middle);
  if (leadMonto && !looksLikeMovementCode(leadMonto[1]!)) {
    const v = parseClpChilean(leadMonto[1]!);
    if (v != null && v > 0) {
      montoClpAbs = v;
      tipoMovimiento = leadMonto[2]!.trim();
    }
  }

  if (montoClpAbs == null) {
    const parts = middle.split(/\s+/).filter(Boolean);
    let best: number | null = null;
    let bestIdx = -1;
    for (let i = 0; i < parts.length; i++) {
      const tok = parts[i]!;
      if (looksLikeMovementCode(tok)) continue;
      const v = parseClpChilean(tok);
      if (v == null || v <= 0) continue;
      if (Math.abs(v - valorCuotaClp) < 2) continue;
      if (Math.abs(v - cuotasAbs) < 0.02 && v < 500) continue;
      if (best == null || v > best) {
        best = v;
        bestIdx = i;
      }
    }
    if (best != null && bestIdx >= 0) {
      montoClpAbs = best;
      tipoMovimiento = parts.slice(0, bestIdx).join(" ").trim();
    }
  }

  if (montoClpAbs == null || !Number.isFinite(montoClpAbs) || montoClpAbs <= 0) return null;

  const codeM = /^(\d{6})\s+(.*)$/i.exec(tipoMovimiento);
  if (codeM) {
    codigo = codeM[1]!;
    tipoMovimiento = codeM[2]!.trim();
  }

  return {
    periodMmYyyy,
    periodYm,
    cargoAbono,
    codigo,
    tipoMovimiento,
    montoClpAbs,
    cuotasAbs,
    valorCuotaClp,
    rutEmpleador,
    fondo,
  };
}

export function parseAfpUnoCertMovimientosText(raw: string): AfpMovimientoCertRow[] {
  const merged = mergeMovimientoPdfLines(raw);
  const out: AfpMovimientoCertRow[] = [];
  for (const ln of merged) {
    const r = parseAfpUnoMovimientoMergedLine(ln);
    if (r) out.push(r);
  }
  return out;
}

/** Semicolon CSV written by `afp-uno-cert-pdf-to-csv.ts` (header row + data). */
export function parseAfpUnoCertMovimientosCsv(raw: string): AfpMovimientoCertRow[] {
  const lines = raw.replace(/\r\n/g, "\n").split("\n");
  const out: AfpMovimientoCertRow[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trim();
    if (!line) continue;
    const cols = line.split(";");
    if (cols.length < 9) continue;
    if (i === 0 && /^period_mm_yyyy/i.test(cols[0]!.trim())) continue;
    const [
      periodMmYyyy,
      cargoAbonoRaw,
      codigo,
      tipoMovimiento,
      montoS,
      cuotasS,
      valorS,
      rutEmpleador,
      fondo,
    ] = cols;
    const periodYm = periodYmFromMmYyyy(periodMmYyyy!.trim());
    if (!periodYm) continue;
    const cb = cargoAbonoRaw!.trim().toLowerCase() === "cargo" ? "Cargo" : "Abono";
    const montoClpAbs = parseClpChilean(montoS!.trim()) ?? 0;
    const cuotasAbs = Math.abs(parseDecimalComma(cuotasS!.trim()) ?? 0);
    const valorCuotaClp = parseClpChilean(valorS!.trim()) ?? 0;
    if (montoClpAbs <= 0 || valorCuotaClp < AFP_UNO_MOVIMIENTOS_VALOR_CUOTA_MIN_CLP) continue;
    out.push({
      periodMmYyyy: periodMmYyyy!.trim(),
      periodYm,
      cargoAbono: cb,
      codigo: codigo?.trim() ?? "",
      tipoMovimiento: tipoMovimiento?.trim() ?? "",
      montoClpAbs,
      cuotasAbs,
      valorCuotaClp,
      rutEmpleador: rutEmpleador!.trim(),
      fondo: fondo!.trim().toUpperCase(),
    });
  }
  return out;
}

export function movimientoRowsToCertMovementRows(rows: AfpMovimientoCertRow[]): AfpCertMovementRow[] {
  const sign = (r: AfpMovimientoCertRow) => (r.cargoAbono === "Cargo" ? -1 : 1);
  return rows.map((r) => {
    const montoClp = sign(r) * r.montoClpAbs;
    const cuotasDelta = sign(r) * r.cuotasAbs;
    return {
      periodYm: r.periodYm,
      tipoRaw: r.tipoMovimiento,
      rutPagador: r.rutEmpleador,
      fondo: r.fondo,
      montoClp,
      fechaCaja: syntheticFechaCajaFromPeriodYm(r.periodYm),
      cuotasAcumuladas: 1,
      cuotasDelta,
      valorCuotaClp: r.valorCuotaClp,
    };
  });
}

export function movimientoRowsToCsv(rows: AfpMovimientoCertRow[]): string {
  const header =
    "period_mm_yyyy;cargo_abono;codigo;tipo_movimiento;monto_clp;cuotas;valor_cuota_clp;rut_empleador;fondo";
  const esc = (s: string) => {
    const t = String(s ?? "").replace(/"/g, '""');
    return /[;\n\r]/.test(t) ? `"${t}"` : t;
  };
  const body = rows.map((r) =>
    [
      r.periodMmYyyy,
      r.cargoAbono,
      esc(r.codigo),
      esc(r.tipoMovimiento),
      String(Math.round(r.montoClpAbs)),
      String(r.cuotasAbs).replace(".", ","),
      String(r.valorCuotaClp).replace(".", ","),
      r.rutEmpleador,
      r.fondo,
    ].join(";")
  );
  return [header, ...body].join("\n") + "\n";
}

export function parseAfpCertificadoBody(
  raw: string,
  fileNameForHint?: string
): { rows: AfpCertMovementRow[]; isMovimientos: boolean } {
  const text = raw.replace(/^\uFEFF/, "").trim();
  const hint = (fileNameForHint ?? "").toLowerCase();

  /** `.csv` is usually movimientos from `afp-uno-cert-pdf-to-csv`; if it does not parse, fall back (legacy cotizaciones). */
  if (hint.endsWith(".csv")) {
    const mr = parseAfpUnoCertMovimientosCsv(text);
    if (mr.length > 0) {
      return { rows: movimientoRowsToCertMovementRows(mr), isMovimientos: true };
    }
  }

  if (isAfpUnoMovimientosCertText(text)) {
    const mr = parseAfpUnoCertMovimientosText(text);
    return { rows: movimientoRowsToCertMovementRows(mr), isMovimientos: true };
  }
  return { rows: parseAfpUnoCertificadoText(text), isMovimientos: false };
}
