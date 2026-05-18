/**
 * Parse AFP Uno “CERTIFICADO COTIZACIONES” text (from `pdftotext` or Cursor PDF extract).
 * Each logical row: contribution period MM-YYYY, CLP amount, fecha caja, cuotas acumuladas, cuotas del movimiento.
 */

export type AfpCertMovementRow = {
  /** Contribution period (March 2026 → "2026-03"). */
  periodYm: string;
  tipoRaw: string;
  rutPagador: string;
  fondo: string;
  montoClp: number;
  /** Fecha caja dd/mm/yyyy */
  fechaCaja: string;
  /** Cuotas totales después del movimiento (certificado). */
  cuotasAcumuladas: number;
  /** Cuotas aportadas en este movimiento. */
  cuotasDelta: number;
  /** UNO “valor cuota” column when present (movimientos cert); optional for cotizaciones-only rows. */
  valorCuotaClp?: number | null;
};

const MONTH_MAP: Record<string, string> = {
  enero: "01",
  febrero: "02",
  marzo: "03",
  abril: "04",
  mayo: "05",
  junio: "06",
  julio: "07",
  agosto: "08",
  septiembre: "09",
  octubre: "10",
  noviembre: "11",
  diciembre: "12",
};

/** Chilean money: `91.552,21` → 91552.21 */
export function parseClpChilean(raw: string): number | null {
  const t = raw.replace(/\s/g, "").replace(/\u00a0/g, "");
  if (!t) return null;
  const lastComma = t.lastIndexOf(",");
  if (lastComma >= 0 && t.length - lastComma - 1 <= 2 && t.length - lastComma - 1 > 0) {
    const intPart = t.slice(0, lastComma).replace(/\./g, "");
    const decPart = t.slice(lastComma + 1);
    const n = Number(`${intPart}.${decPart}`);
    return Number.isFinite(n) ? n : null;
  }
  const digits = t.replace(/\./g, "");
  const n = Number(digits);
  return Number.isFinite(n) ? n : null;
}

/** Decimal with comma (optional thousands with dot): `3,96` → 3.96, `1.234,5` → 1234.5 */
export function parseDecimalComma(raw: string): number | null {
  const t = raw.replace(/\s/g, "").replace(/\u00a0/g, "");
  if (!t) return null;
  const lastComma = t.lastIndexOf(",");
  if (lastComma < 0) {
    const n = Number(t.replace(/\./g, ""));
    return Number.isFinite(n) ? n : null;
  }
  const intPart = t.slice(0, lastComma).replace(/\./g, "");
  const decPart = t.slice(lastComma + 1).replace(/\./g, "");
  const n = Number(`${intPart}.${decPart}`);
  return Number.isFinite(n) ? n : null;
}

/** Running total cuotas (often `362.242` = 362.242 units; no thousands comma). */
export function parseCuotasNumber(raw: string): number | null {
  const t = raw.replace(/\s/g, "").trim();
  if (!t) return null;
  if (t.includes(",")) {
    return parseDecimalComma(t);
  }
  const parts = t.split(".");
  if (parts.length === 2) {
    const n = Number(`${parts[0]}.${parts[1]}`);
    return Number.isFinite(n) ? n : null;
  }
  if (parts.length > 2) {
    const n = Number(parts.join(""));
    return Number.isFinite(n) ? n : null;
  }
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

export function periodMmYyyyToYm(mmDashYyyy: string): string | null {
  const m = /^(\d{2})-(\d{4})$/.exec(mmDashYyyy.trim());
  if (!m) return null;
  return `${m[2]}-${m[1]}`;
}

/** Normalize multiline “RELIQUIDACION / TRASPASO INGRESO” blocks to single spaces. */
export function normalizeAfpCertText(raw: string): string {
  return raw
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/Página\s+\d+\s+de\s+\d+[^\n]*/gi, "\n")
    .replace(/--\s*\d+\s+of\s+\d+\s*--/gi, "\n");
}

/**
 * Split into record chunks: each starts with `MM-YYYY` at line beginning (after trim).
 */
export function splitAfpCertRecords(text: string): string[] {
  const lines = normalizeAfpCertText(text).split("\n");
  const chunks: string[] = [];
  let cur: string[] = [];
  for (const line of lines) {
    const t = line.trim();
    if (!t) continue;
    if (/^\d{2}-\d{4}\s/.test(t)) {
      if (cur.length) chunks.push(cur.join(" "));
      cur = [t];
    } else if (cur.length) {
      cur.push(t);
    }
  }
  if (cur.length) chunks.push(cur.join(" "));
  return chunks;
}

/**
 * One-line record after split: `03-2026 COTIZACION NORMAL 77.239.911-1 A 91.552,21 08/04/2026 362.242 3,96`
 * (spaces may collapse from tabs).
 */
export function parseAfpCertRecordLine(oneLine: string): AfpCertMovementRow | null {
  /** pypdf often drops the space between “,DD” and “DD/MM/YYYY”. */
  const s0 = oneLine.replace(/\s+/g, " ").trim();
  const s = s0.replace(/,(\d{2})(\d{2}\/\d{2}\/\d{4})/g, ",$1 $2");
  const head = /^(\d{2}-\d{4})\s+(.+?)\s+(\d{2}\.\d{3}\.\d{3}-[\dkK])\s+([A-E])\s+/iu.exec(s);
  if (!head) return null;
  const periodMmYyyy = head[1]!;
  const tipoRaw = head[2]!.trim();
  const rutPagador = head[3]!;
  const fondo = head[4]!;
  const rest = s.slice(head[0].length).trim();

  const fechaRe = /(\d{2}\/\d{2}\/\d{4})/;
  const fm = fechaRe.exec(rest);
  if (!fm) return null;
  const fechaCaja = fm[1]!;
  const before = rest.slice(0, fm.index).trim();
  const after = rest.slice(fm.index + fechaCaja.length).trim();

  const tailParts = after.split(/\s+/).filter(Boolean);
  if (tailParts.length < 2) return null;
  const cuotasDeltaRaw = tailParts[tailParts.length - 1]!;
  const cuotasAcumRaw = tailParts[tailParts.length - 2]!;

  const montoParts = before.split(/\s+/).filter(Boolean);
  if (montoParts.length < 1) return null;
  const montoRaw = montoParts[montoParts.length - 1]!;
  const montoClp = parseClpChilean(montoRaw);
  const cuotasDelta = parseDecimalComma(cuotasDeltaRaw);
  const cuotasAcumuladas = parseCuotasNumber(cuotasAcumRaw);
  if (montoClp == null || cuotasDelta == null || cuotasAcumuladas == null) return null;
  if (montoClp <= 0 || cuotasDelta <= 0 || cuotasAcumuladas <= 0) return null;

  const periodYm = periodMmYyyyToYm(periodMmYyyy);
  if (!periodYm) return null;

  return {
    periodYm,
    tipoRaw,
    rutPagador,
    fondo,
    montoClp,
    fechaCaja,
    cuotasAcumuladas,
    cuotasDelta,
  };
}

export function parseAfpUnoCertificadoText(text: string): AfpCertMovementRow[] {
  const out: AfpCertMovementRow[] = [];
  for (const chunk of splitAfpCertRecords(text)) {
    const row = parseAfpCertRecordLine(chunk);
    if (row) out.push(row);
  }
  return out;
}

/** `14 de mayo de 2026` → `2026-05-14` (Spanish month names). */
export function parseSpanishCertDateLine(line: string): string | null {
  const m = /(\d{1,2})\s+de\s+(\w+)\s+de\s+(\d{4})/i.exec(line);
  if (!m) return null;
  const d = String(m[1]).padStart(2, "0");
  const mon = MONTH_MAP[m[2]!.toLowerCase()];
  const y = m[3]!;
  if (!mon) return null;
  return `${y}-${mon}-${d}`;
}
