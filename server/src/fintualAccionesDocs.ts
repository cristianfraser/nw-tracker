/**
 * Fintual «Acciones» documents → typed records. Pure text parsing, no DB.
 *
 * Two PDFs, both fetched from Gmail by `scraper` (`fetch:fintual-docs`) into
 * `cfraser/fintual-acciones/`, both read as `pdftotext -layout` text:
 *
 *  - **Alpaca monthly statement** («Cartola mensual de Acciones», ~the 10th of the next month).
 *    Its Income section prints each dividend as two lines —
 *      `07/31/2026 Dividends SPY Cash DIV @ 1.903516, Pos QTY: 1.027327209, Rec Date: 2026-06-18 $1.96`
 *      `07/31/2026 Div. Adj(NRA Withheld) SPY DIV tax withholding on $1.96 at 15% for tax country CHL; w8w9: w8 -$0.29`
 *    — the gross, the per-share rate, the position, the record date, the withholding, its rate
 *    and the payee's tax country. A dividend with no NRA line was credited in full (an Irish
 *    plc such as LIN). Sweep interest prints as `06/30/2026 Cash Interest** - June 2026 Sweep $0.02`.
 *  - **Certificado de transacciones y eventos de capital** (requested by hand in the app).
 *    Its «Dividendos recibidos» table prints bruto / impuestos / neto per dividend, with the
 *    date split across lines by the layout (`2025-01-` … `31`).
 *
 * Every line inside a parsed section must match a known shape or the parse throws: a new entry
 * type in the Income section is exactly the thing that must not be skipped silently.
 */
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { parseChileanNumber, parseUsNumber } from "./chileanNumber.js";

export function pdfLayoutText(filePath: string): string {
  const abs = String(filePath ?? "").trim();
  if (!abs || !fs.existsSync(abs)) throw new Error(`fintual acciones: file not found: ${filePath}`);
  return execFileSync("pdftotext", ["-layout", abs, "-"], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
}

// ---------------------------------------------------------------------------------------------
// Alpaca monthly statement
// ---------------------------------------------------------------------------------------------

export type AlpacaDividendIncome = {
  /** Trade date of the credit, `YYYY-MM-DD`. */
  trade_date: string;
  symbol: string;
  gross: number;
  per_share: number;
  position_qty: number;
  record_date: string;
  /** 0 when the statement prints no NRA line for the dividend. */
  withholding: number;
  withholding_rate_pct: number | null;
  /** The payee's tax country as Alpaca prints it (`CHL`). */
  tax_country: string | null;
  /** Alpaca's W-8/W-9 status token (`w8`). */
  w8w9: string | null;
  net: number;
};

export type AlpacaCashInterest = { trade_date: string; amount: number; description: string };

export type AlpacaHolding = { symbol: string; description: string; quantity: number };

export type AlpacaMonthlyStatement = {
  /** `YYYY-MM` of the statement period. */
  period_ym: string;
  dividends: AlpacaDividendIncome[];
  interest: AlpacaCashInterest[];
  /** Month-end positions, informational (the ledger's own units are the truth). */
  holdings: AlpacaHolding[];
};

const MONTHS_EN: Record<string, number> = {
  JANUARY: 1, FEBRUARY: 2, MARCH: 3, APRIL: 4, MAY: 5, JUNE: 6,
  JULY: 7, AUGUST: 8, SEPTEMBER: 9, OCTOBER: 10, NOVEMBER: 11, DECEMBER: 12,
};

const RE_PERIOD = /Period:\s+([A-Z]+)\s+-\s+(\d{4})/;
const RE_DIVIDEND =
  /^(\d{2})\/(\d{2})\/(\d{4}) Dividends (\S+) Cash DIV @ ([\d.]+), Pos QTY: ([\d.]+), Rec Date: (\d{4}-\d{2}-\d{2}) \$([\d,]+\.\d{2})$/;
const RE_NRA =
  /^(\d{2})\/(\d{2})\/(\d{4}) Div\. Adj\(NRA Withheld\) (\S+) DIV tax withholding on \$([\d,]+\.\d{2}) at ([\d.]+)% for tax country ([A-Z]{2,3}); w8w9: (\S+) -\$([\d,]+\.\d{2})$/;
const RE_INTEREST = /^(\d{2})\/(\d{2})\/(\d{4}) Cash Interest\*\* - (.+?) \$([\d,]+\.\d{2})$/;
const RE_HOLDING = /^(\S+) (.+?) ([\d.]+) \$[\d,.]+ \$[\d,.]+ \$[\d,.]+ -?\$[\d,.]+ \$[\d,.]+$/;

function collapse(line: string): string {
  return line.replace(/\s+/g, " ").trim();
}

function usYmd(mm: string, dd: string, yyyy: string): string {
  return `${yyyy}-${mm}-${dd}`;
}

/** Lines strictly between the first line equal to `start` and the next line equal to `end`. */
function sectionLines(lines: readonly string[], start: string, end: string): string[] {
  const from = lines.findIndex((l) => collapse(l) === start);
  if (from < 0) throw new Error(`fintual acciones: statement has no «${start}» section`);
  const to = lines.findIndex((l, i) => i > from && collapse(l) === end);
  if (to < 0) throw new Error(`fintual acciones: «${start}» section is not closed by «${end}»`);
  return lines.slice(from + 1, to).map(collapse).filter((l) => l !== "" && !/^\d+$/.test(l));
}

export function parseAlpacaMonthlyStatementText(text: string): AlpacaMonthlyStatement {
  const lines = String(text ?? "").split("\n");
  const periodLine = lines.map(collapse).find((l) => RE_PERIOD.test(l));
  const period = periodLine ? RE_PERIOD.exec(periodLine) : null;
  if (!period) throw new Error("fintual acciones: statement has no «Period: MONTH - YYYY» header");
  const month = MONTHS_EN[period[1]!];
  if (!month) throw new Error(`fintual acciones: unknown statement month «${period[1]}»`);
  const periodYm = `${period[2]}-${String(month).padStart(2, "0")}`;

  const dividends: AlpacaDividendIncome[] = [];
  const nra: { trade_date: string; symbol: string; on: number; rate: number; country: string; w8w9: string; tax: number }[] = [];
  const interest: AlpacaCashInterest[] = [];
  for (const line of sectionLines(lines, "Income", "Fees")) {
    if (line === "Trade Date Entry Type Symbol Description Net Amt" || line === "No record found.") continue;
    const div = RE_DIVIDEND.exec(line);
    if (div) {
      dividends.push({
        trade_date: usYmd(div[1]!, div[2]!, div[3]!),
        symbol: div[4]!.toUpperCase(),
        per_share: parseUsNumber(div[5]!),
        position_qty: parseUsNumber(div[6]!),
        record_date: div[7]!,
        gross: parseUsNumber(div[8]!),
        withholding: 0,
        withholding_rate_pct: null,
        tax_country: null,
        w8w9: null,
        net: parseUsNumber(div[8]!),
      });
      continue;
    }
    const w = RE_NRA.exec(line);
    if (w) {
      nra.push({
        trade_date: usYmd(w[1]!, w[2]!, w[3]!),
        symbol: w[4]!.toUpperCase(),
        on: parseUsNumber(w[5]!),
        rate: parseUsNumber(w[6]!),
        country: w[7]!,
        w8w9: w[8]!,
        tax: parseUsNumber(w[9]!),
      });
      continue;
    }
    const i = RE_INTEREST.exec(line);
    if (i) {
      interest.push({ trade_date: usYmd(i[1]!, i[2]!, i[3]!), description: i[4]!, amount: parseUsNumber(i[5]!) });
      continue;
    }
    throw new Error(`fintual acciones: unrecognised Income line «${line}» — extend the parser rather than skip it`);
  }

  for (const w of nra) {
    const hits = dividends.filter(
      (d) => d.trade_date === w.trade_date && d.symbol === w.symbol && Math.abs(d.gross - w.on) <= 0.005
    );
    if (hits.length !== 1) {
      throw new Error(
        `fintual acciones: NRA withholding line for ${w.symbol} on ${w.trade_date} (on $${w.on}) matches ${hits.length} dividend line(s)`
      );
    }
    const d = hits[0]!;
    if (d.withholding_rate_pct != null) {
      throw new Error(`fintual acciones: two NRA lines for the ${w.symbol} dividend of ${w.trade_date}`);
    }
    d.withholding = w.tax;
    d.withholding_rate_pct = w.rate;
    d.tax_country = w.country;
    d.w8w9 = w.w8w9;
    d.net = Math.round((d.gross - w.tax) * 100) / 100;
  }

  const holdings: AlpacaHolding[] = [];
  const holdingsFrom = lines.findIndex((l) => collapse(l) === "Holdings");
  if (holdingsFrom >= 0) {
    for (const line of sectionLines(lines, "Holdings", "Income")) {
      if (line.startsWith("Symbol Description") || line.startsWith("*Cash ")) continue;
      const h = RE_HOLDING.exec(line);
      if (!h) throw new Error(`fintual acciones: unrecognised Holdings line «${line}»`);
      holdings.push({ symbol: h[1]!.toUpperCase(), description: h[2]!, quantity: parseUsNumber(h[3]!) });
    }
  }

  return { period_ym: periodYm, dividends, interest, holdings };
}

// ---------------------------------------------------------------------------------------------
// Certificado de transacciones y eventos de capital
// ---------------------------------------------------------------------------------------------

export type CertificadoDividend = {
  /** The date the certificate prints for the dividend, `YYYY-MM-DD`. */
  date: string;
  symbol: string;
  category: string;
  gross: number;
  tax: number;
  net: number;
};

export type FintualAccionesCertificado = {
  /** `YYYY-MM-DD` the certificate was issued. */
  issued_on: string;
  dividends: CertificadoDividend[];
};

const MONTHS_ES: Record<string, number> = {
  enero: 1, febrero: 2, marzo: 3, abril: 4, mayo: 5, junio: 6,
  julio: 7, agosto: 8, septiembre: 9, octubre: 10, noviembre: 11, diciembre: 12,
};

const RE_ISSUED = /Con fecha (\d{1,2}) de ([a-záéíóú]+) de (\d{4})/i;
const RE_CERT_DATE_PREFIX = /^\s*(\d{4}-\d{2}-)\s/;
const RE_CERT_AMOUNTS = /^\s*([A-Z][A-Z0-9.]{0,9})\s+(\S+)\s+US \$ ([\d.,]+)\s+US \$ ([\d.,]+)\s+US \$ ([\d.,]+)\s*$/;
const RE_CERT_DAY_SUFFIX = /^\s*(\d{2})(?:\s|$)/;

export function parseFintualAccionesCertificadoText(text: string): FintualAccionesCertificado {
  const lines = String(text ?? "").split("\n");
  const issued = RE_ISSUED.exec(String(text ?? "").replace(/\s+/g, " "));
  if (!issued) throw new Error("fintual acciones: certificado has no «Con fecha D de MES de YYYY» line");
  const issuedMonth = MONTHS_ES[issued[2]!.toLowerCase()];
  if (!issuedMonth) throw new Error(`fintual acciones: unknown certificado month «${issued[2]}»`);
  const issuedOn = `${issued[3]}-${String(issuedMonth).padStart(2, "0")}-${issued[1]!.padStart(2, "0")}`;

  const from = lines.findIndex((l) => /Dividendos recibidos/.test(l));
  if (from < 0) return { issued_on: issuedOn, dividends: [] };
  const to = lines.findIndex((l, i) => i > from && /Este certificado/.test(l));
  const section = lines.slice(from + 1, to < 0 ? lines.length : to);

  const dividends: CertificadoDividend[] = [];
  let pending: { prefix: string; amounts: RegExpExecArray | null } | null = null;
  for (const line of section) {
    const prefix = RE_CERT_DATE_PREFIX.exec(line);
    if (prefix) {
      if (pending) throw new Error(`fintual acciones: certificado dividend row ${pending.prefix}… never closed`);
      pending = { prefix: prefix[1]!, amounts: null };
      continue;
    }
    const amounts = RE_CERT_AMOUNTS.exec(line);
    if (amounts) {
      if (!pending || pending.amounts) throw new Error(`fintual acciones: certificado amounts line «${collapse(line)}» without a date`);
      pending.amounts = amounts;
      continue;
    }
    const day = RE_CERT_DAY_SUFFIX.exec(line);
    if (day && pending?.amounts) {
      const a = pending.amounts;
      const gross = parseChileanNumber(a[3]!);
      const tax = parseChileanNumber(a[4]!);
      const net = parseChileanNumber(a[5]!);
      if (Math.abs(gross - tax - net) > 0.015) {
        throw new Error(`fintual acciones: certificado dividend ${pending.prefix}${day[1]} ${a[1]} does not add up (${gross} − ${tax} ≠ ${net})`);
      }
      dividends.push({ date: `${pending.prefix}${day[1]}`, symbol: a[1]!.toUpperCase(), category: a[2]!, gross, tax, net });
      pending = null;
    }
  }
  if (pending) throw new Error(`fintual acciones: certificado dividend row ${pending.prefix}… never closed`);
  return { issued_on: issuedOn, dividends };
}
