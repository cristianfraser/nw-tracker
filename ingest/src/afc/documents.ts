/**
 * AFC (Fondo de Cesantía) documents from the AFC sucursal virtual, read as `pdftotext -layout`
 * text (moved from the server's `afcCertImport.ts`, which applies what they print):
 *
 * 1. **Certificado de cotizaciones previsionales acreditadas** — every cotización with período,
 *    empleador, renta imponible, monto and the exact fecha de pago, two legs per período, closed
 *    by a `TOTAL` line the parse must reproduce.
 * 2. **Estado cuatrimestral** (cartola) — saldo inicial / final with their dates, the period's
 *    cotizaciones (by mes de pago), ganancia, comisiones; every printed identity is checked.
 *
 * Fail-fast: a layout change surfaces as a thrown error, never as a skipped cotización.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import type { UnemploymentFundDocumentsPayload } from "nw-tracker-contracts";

const SPANISH_MONTHS: Record<string, number> = {
  enero: 1,
  febrero: 2,
  marzo: 3,
  abril: 4,
  mayo: 5,
  junio: 6,
  julio: 7,
  agosto: 8,
  septiembre: 9,
  setiembre: 9,
  octubre: 10,
  noviembre: 11,
  diciembre: 12,
};

function normalizeWord(s: string): string {
  return s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim();
}

/** `Septiembre` → 9, or null when the word is not a Spanish month name. */
export function spanishMonthNumber(word: string): number | null {
  return SPANISH_MONTHS[normalizeWord(word)] ?? null;
}

function parseClpInteger(raw: string): number {
  const s = raw.trim().replace(/^\$/, "").replace(/\./g, "");
  if (!/^-?\d+$/.test(s)) throw new Error(`afc: unparsable CLP amount «${raw}»`);
  return Number(s);
}

function ymd(year: number, month: number, day: number): string {
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

export function pdfTextLayout(filePath: string): string {
  const abs = filePath.trim();
  if (!abs || !fs.existsSync(abs)) throw new Error(`afc: file not found: ${filePath}`);
  return execFileSync("pdftotext", ["-layout", abs, "-"], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
}

// ---------------------------------------------------------------------------------------------
// Certificado de cotizaciones
// ---------------------------------------------------------------------------------------------

export type AfcCotizacionLeg = {
  /** `YYYY-MM` período the cotización belongs to. */
  period_ym: string;
  employer_rut: string;
  /** May be empty when the layout wrapped the name onto its own lines. */
  employer: string;
  renta_imponible_clp: number;
  amount_clp: number;
  /** Fecha de pago — the day the AFC credits the cuotas. */
  pay_ymd: string;
};

export type AfcCotizacionesCertificate = {
  legs: AfcCotizacionLeg[];
  total_clp: number;
};

const RUT_RE = /\d{1,3}(?:\.\d{3})*-[\dkK]/;
const DATA_LINE_RE = new RegExp(
  `^\\s*(?:([A-Za-zÁÉÍÓÚáéíóúñÑ]+)(?:\\s+(\\d{4}))?)?\\s*(${RUT_RE.source})\\s+(.*?)\\s*\\$([\\d.]+)\\s+\\$([\\d.]+)\\s+(\\d{2})/(\\d{2})/(\\d{4})\\s*$`
);
const BARE_MONTH_RE = /^\s*([A-Za-zÁÉÍÓÚáéíóúñÑ]+)\s*$/;
const BARE_YEAR_RE = /^\s*(\d{4})\s*$/;
const TOTAL_RE = /^\s*TOTAL\s+\$([\d.]+)\s*$/;

/**
 * Parse the certificate text. Fail-fast: every line that carries a RUT + amounts + date must
 * parse with a período (its own «Mes YYYY» prefix, or the month/year the layout printed on the
 * surrounding lines), the `TOTAL` line must exist and equal Σ montos, and every leg must be a
 * positive amount. A layout change surfaces as a thrown error, never as a skipped cotización.
 */
export function parseAfcCotizacionesCertificate(text: string): AfcCotizacionesCertificate {
  const lines = text.split(/\r?\n/);
  const legs: AfcCotizacionLeg[] = [];
  let total: number | null = null;
  let pendingMonth: number | null = null;
  let pendingPeriod: string | null = null;
  let awaitingYear: AfcCotizacionLeg[] = [];
  let inTable = false;
  for (const raw of lines) {
    const line = raw.replace(/\s+$/, "");
    if (!line.trim()) continue;
    if (/Fecha de\s*$/.test(line) || /^\s*Período\b/.test(line)) {
      inTable = true;
      continue;
    }
    const total_m = TOTAL_RE.exec(line);
    if (total_m) {
      total = parseClpInteger(total_m[1]!);
      inTable = false;
      continue;
    }
    if (!inTable) continue;
    const dm = DATA_LINE_RE.exec(line);
    if (dm) {
      const [, monthWord, yearStr, rut, employer, renta, monto, dd, mm, yyyy] = dm;
      const leg: AfcCotizacionLeg = {
        period_ym: "",
        employer_rut: rut!,
        employer: (employer ?? "").trim(),
        renta_imponible_clp: parseClpInteger(renta!),
        amount_clp: parseClpInteger(monto!),
        pay_ymd: ymd(Number(yyyy), Number(mm), Number(dd)),
      };
      if (leg.amount_clp <= 0) throw new Error(`afc: non-positive cotización «${line.trim()}»`);
      if (monthWord && yearStr) {
        const mo = spanishMonthNumber(monthWord);
        if (mo == null) throw new Error(`afc: unknown month «${monthWord}» in «${line.trim()}»`);
        leg.period_ym = `${yearStr}-${String(mo).padStart(2, "0")}`;
        pendingMonth = null;
        pendingPeriod = null;
      } else if (monthWord) {
        // «Septiembre <data…>» with the year printed on the next line.
        const mo = spanishMonthNumber(monthWord);
        if (mo == null) throw new Error(`afc: unknown month «${monthWord}» in «${line.trim()}»`);
        if (awaitingYear.length > 0) throw new Error(`afc: month «${monthWord}» before the previous período's year`);
        pendingMonth = mo;
        pendingPeriod = null;
        awaitingYear.push(leg);
      } else if (pendingPeriod) {
        leg.period_ym = pendingPeriod;
      } else if (pendingMonth != null) {
        awaitingYear.push(leg);
      } else {
        throw new Error(`afc: cotización line without a período «${line.trim()}»`);
      }
      legs.push(leg);
      continue;
    }
    const ym_ = BARE_YEAR_RE.exec(line);
    if (ym_) {
      if (pendingMonth == null) throw new Error(`afc: stray year line «${line.trim()}»`);
      const period = `${ym_[1]}-${String(pendingMonth).padStart(2, "0")}`;
      if (awaitingYear.length > 0) {
        for (const l of awaitingYear) l.period_ym = period;
        awaitingYear = [];
        pendingMonth = null;
      } else {
        pendingPeriod = period;
      }
      continue;
    }
    const bm = BARE_MONTH_RE.exec(line);
    if (bm) {
      const mo = spanishMonthNumber(bm[1]!);
      if (mo != null) {
        if (awaitingYear.length > 0) throw new Error(`afc: month «${bm[1]}» before the previous período's year`);
        pendingMonth = mo;
        pendingPeriod = null;
      }
      // Any other bare word is an employer-name fragment the layout wrapped — ignored.
      continue;
    }
    // Employer fragments with several words / punctuation — ignored likewise.
  }
  if (awaitingYear.length > 0) throw new Error("afc: certificate ended with cotizaciones awaiting their year");
  if (legs.length === 0) throw new Error("afc: no cotizaciones parsed — layout changed?");
  if (total == null) throw new Error("afc: TOTAL line missing");
  const sum = legs.reduce((a, l) => a + l.amount_clp, 0);
  if (sum !== total) throw new Error(`afc: Σ cotizaciones ${sum} ≠ printed TOTAL ${total}`);
  for (const l of legs) if (!/^\d{4}-\d{2}$/.test(l.period_ym)) throw new Error("afc: leg without período");
  return { legs, total_clp: total };
}

// ---------------------------------------------------------------------------------------------
// Estado cuatrimestral (cartola)
// ---------------------------------------------------------------------------------------------

export type AfcCartola = {
  period_from_ymd: string;
  period_to_ymd: string;
  saldo_inicial_ymd: string;
  saldo_inicial_clp: number;
  cotizaciones_clp: number;
  otros_ingresos_clp: number;
  ganancia_clp: number;
  total_ingresos_clp: number;
  comisiones_clp: number;
  otros_egresos_clp: number;
  uso_cuenta_clp: number;
  total_egresos_clp: number;
  saldo_final_ymd: string;
  saldo_final_clp: number;
  detalle: { employer: string; pay_month_ym: string; amount_clp: number }[];
};

const PERIOD_RE = /per[ií]odo del (\d{1,2}) de ([A-Za-zÁÉÍÓÚáéíóúñÑ]+) al (\d{1,2}) de ([A-Za-zÁÉÍÓÚáéíóúñÑ]+) de (\d{4})/i;
const SALDO_INICIAL_RE = /Al (\d{2})-(\d{2})-(\d{4})\s+\(1\)\s+\$([\d.]+)/;
const SALDO_FINAL_RE = /Al (\d{2})-(\d{2})-(\d{4})\s+\(1\+2-3\)\s+\$([\d.]+)/;
const AMOUNTS_RE = /\$-?[\d.]+/g;
const DETALLE_ROW_RE = /^\s*(.+?)\s{2,}([A-Za-zÁÉÍÓÚáéíóúñÑ]+)-(\d{4})\s+\$([\d.]+)\s*$/;

function monthOrThrow(word: string): number {
  const mo = spanishMonthNumber(word);
  if (mo == null) throw new Error(`afc cartola: unknown month «${word}»`);
  return mo;
}

/** Parse the cuatrimestral cartola; every printed identity is checked, a mismatch throws. */
export function parseAfcCartola(text: string): AfcCartola {
  const lines = text.split(/\r?\n/).map((l) => l.replace(/\s+$/, ""));
  const joined = lines.join("\n");
  const pm = PERIOD_RE.exec(joined);
  if (!pm) throw new Error("afc cartola: período line not found");
  const year = Number(pm[5]);
  const period_from_ymd = ymd(year, monthOrThrow(pm[2]!), Number(pm[1]));
  const period_to_ymd = ymd(year, monthOrThrow(pm[4]!), Number(pm[3]));
  const si = SALDO_INICIAL_RE.exec(joined);
  const sf = SALDO_FINAL_RE.exec(joined);
  if (!si) throw new Error("afc cartola: saldo inicial not found");
  if (!sf) throw new Error("afc cartola: saldo final not found");
  const saldo_inicial_ymd = ymd(Number(si[3]), Number(si[2]), Number(si[1]));
  const saldo_final_ymd = ymd(Number(sf[3]), Number(sf[2]), Number(sf[1]));
  const saldo_inicial_clp = parseClpInteger(si[4]!);
  const saldo_final_clp = parseClpInteger(sf[4]!);

  const amountsAfter = (headerRe: RegExp, count: number, what: string): number[] => {
    const idx = lines.findIndex((l) => headerRe.test(l));
    if (idx < 0) throw new Error(`afc cartola: «${what}» header not found`);
    for (let i = idx + 1; i < Math.min(lines.length, idx + 4); i++) {
      const found = lines[i]!.match(AMOUNTS_RE);
      if (found && found.length >= count) return found.slice(0, count).map(parseClpInteger);
    }
    throw new Error(`afc cartola: ${count} amounts under «${what}» not found`);
  };
  const [cotizaciones_clp, otros_ingresos_clp, ganancia_clp, total_ingresos_clp] = amountsAfter(
    /Total de cotizaciones/,
    4,
    "Total de cotizaciones"
  ) as [number, number, number, number];
  const [comisiones_clp, otros_egresos_clp, uso_cuenta_clp, total_egresos_clp] = amountsAfter(
    /Total comisiones/,
    4,
    "Total comisiones"
  ) as [number, number, number, number];

  const detalle: AfcCartola["detalle"] = [];
  const dStart = lines.findIndex((l) => /Detalle de cotizaciones/.test(l));
  if (dStart < 0) throw new Error("afc cartola: «Detalle de cotizaciones» not found");
  for (let i = dStart + 1; i < lines.length; i++) {
    const l = lines[i]!;
    if (/^\s*Total\s+\$/.test(l) || /Beneficios del Fondo/.test(l)) break;
    const dm = DETALLE_ROW_RE.exec(l);
    if (!dm) continue;
    detalle.push({
      employer: dm[1]!.trim(),
      pay_month_ym: `${dm[3]}-${String(monthOrThrow(dm[2]!)).padStart(2, "0")}`,
      amount_clp: parseClpInteger(dm[4]!),
    });
  }

  if (cotizaciones_clp + otros_ingresos_clp + ganancia_clp !== total_ingresos_clp) {
    throw new Error("afc cartola: ingresos do not add up to the printed total");
  }
  if (comisiones_clp + otros_egresos_clp + uso_cuenta_clp !== total_egresos_clp) {
    throw new Error("afc cartola: egresos do not add up to the printed total");
  }
  if (saldo_inicial_clp + total_ingresos_clp - total_egresos_clp !== saldo_final_clp) {
    throw new Error("afc cartola: saldo final ≠ inicial + ingresos − egresos");
  }
  const detalleSum = detalle.reduce((a, d) => a + d.amount_clp, 0);
  if (detalleSum !== cotizaciones_clp) {
    throw new Error(`afc cartola: Σ detalle ${detalleSum} ≠ Total de cotizaciones ${cotizaciones_clp}`);
  }
  return {
    period_from_ymd,
    period_to_ymd,
    saldo_inicial_ymd,
    saldo_inicial_clp,
    cotizaciones_clp,
    otros_ingresos_clp,
    ganancia_clp,
    total_ingresos_clp,
    comisiones_clp,
    otros_egresos_clp,
    uso_cuenta_clp,
    total_egresos_clp,
    saldo_final_ymd,
    saldo_final_clp,
    detalle,
  };
}

// ---------------------------------------------------------------------------------------------
// The ingest kind
// ---------------------------------------------------------------------------------------------

export function unemploymentFundDocumentsPayload(
  cert: AfcCotizacionesCertificate,
  cartolas: readonly AfcCartola[],
  opts: { apply: boolean; accountId: number | null; replaceExcelRows: boolean; dropMovementIds: number[] }
): UnemploymentFundDocumentsPayload {
  return {
    apply: opts.apply,
    provider: "afc",
    account_id: opts.accountId,
    certificate: {
      legs: cert.legs.map((l) => ({
        period_month: l.period_ym,
        employer_rut: l.employer_rut,
        employer: l.employer,
        taxable_income: l.renta_imponible_clp,
        amount: l.amount_clp,
        paid_on: l.pay_ymd,
      })),
      total: cert.total_clp,
    },
    statements: cartolas.map((c) => ({
      period_from: c.period_from_ymd,
      period_to: c.period_to_ymd,
      opening: { date: c.saldo_inicial_ymd, balance: c.saldo_inicial_clp },
      closing: { date: c.saldo_final_ymd, balance: c.saldo_final_clp },
      contributions: c.cotizaciones_clp,
      other_income: c.otros_ingresos_clp,
      gain: c.ganancia_clp,
      total_income: c.total_ingresos_clp,
      commissions: c.comisiones_clp,
      other_outflows: c.otros_egresos_clp,
      account_use: c.uso_cuenta_clp,
      total_outflows: c.total_egresos_clp,
      detail: c.detalle.map((d) => ({ employer: d.employer, pay_month: d.pay_month_ym, amount: d.amount_clp })),
    })),
    options: { replace_excel_rows: opts.replaceExcelRows, drop_movement_ids: opts.dropMovementIds },
  };
}
