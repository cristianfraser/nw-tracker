/**
 * Previred's monthly «Indicadores Previsionales» (one PDF per payroll month, from its public
 * archive): the month's UF and UTM, the taxable caps for pension/health and unemployment insurance
 * (in UF), each AFP's rate charged to the worker (10 % + its commission) and, from August 2025, the
 * employer's share into the worker's account, and the unemployment-insurance rates of an indefinite
 * contract. Read from `pdftotext -layout`; a field the document does not yield fails the read.
 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { resolveCfraserDir } from "../paths.js";

export const PREVIRED_ARCHIVE_URL = "https://www.previred.com/indicadores-previsionales/";

const MONTHS: Record<string, number> = {
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

const AFP_NAMES: Record<string, string> = {
  capital: "capital",
  cuprum: "cuprum",
  habitat: "habitat",
  planvital: "planvital",
  provida: "provida",
  modelo: "modelo",
  uno: "uno",
};

export type PreviredIndicators = {
  period_month: string;
  uf: number;
  utm: number;
  pension_cap_uf: number;
  unemployment_cap_uf: number;
  /** AFP → rate charged to a dependent worker (percent, e.g. 10.46). */
  afp_worker_rates: Record<string, number>;
  /** The employer's share into the worker's own account (percent; 0 before August 2025). */
  afp_employer_rate: number;
  /** Indefinite contract: worker and employer unemployment-insurance rates (percent). */
  afc_worker_rate: number;
  afc_employer_rate: number;
};

function pct(raw: string): number {
  return Number(raw.replace(",", "."));
}

function chileanAmount(raw: string): number {
  return Number(raw.replace(/\./g, "").replace(",", "."));
}

const ym = (y: number, m: number) => `${y}-${String(m).padStart(2, "0")}`;

export function parsePreviredIndicators(text: string): PreviredIndicators {
  const period = /Remuneraciones\s+([A-Za-zé]+)\s+(\d{4})/i.exec(text);
  const monthNum = period ? MONTHS[period[1]!.toLowerCase()] : undefined;
  if (!period || !monthNum) throw new Error("previred: no «(Remuneraciones <Mes> <año>)»");
  const year = Number(period[2]);
  const periodMonth = ym(year, monthNum);

  // «Al 31 de Mayo 2017: $ 26.630,98» / «al 30 de Septiembre del 2026: $ 41.057,20»: the month's own.
  let uf: number | null = null;
  for (const m of text.matchAll(/al\s+\d{1,2}\s+de\s+([A-Za-zé]+)(?:\s+del)?\s+(\d{4})\s*:\s*\$\s*([\d.]+,\d+)/gi)) {
    if (MONTHS[m[1]!.toLowerCase()] === monthNum && Number(m[2]) === year) uf = chileanAmount(m[3]!);
  }
  if (uf == null) throw new Error(`previred ${periodMonth}: no UF for the month's last day`);

  // «Mayo 2017   $ 46.647   $ 559.764» (UTM then UTA).
  // (Dec 2022 – Feb 2023 print the UTM without its «$».)
  const utmRe = new RegExp(`${period[1]}\\s+(?:del\\s+)?${year}\\s+\\$?\\s*([\\d.]+)\\s+\\$`, "i");
  const utmM = utmRe.exec(text);
  if (!utmM) throw new Error(`previred ${periodMonth}: no UTM`);

  const capM = /afiliados\s+a\s+una\s+AFP\s*\((\d+(?:,\d+)?)\s*UF\)/i.exec(text);
  const afcCapM = /Seguro\s+de\s+Cesant[ií]a\s*\((\d+(?:,\d+)?)\s*UF\)/i.exec(text);
  if (!capM || !afcCapM) throw new Error(`previred ${periodMonth}: no taxable caps`);

  // From August 2025 the table has a «Cargo del Empleador» column (the employer's share into the
  // account); before it, the second column is the SIS, which is not the worker's money.
  const employerColumn = /Cargo del\s+Empleador|Cargo del\s+Cargo del/i.test(text);
  const rates: Record<string, number> = {};
  let employerRate: number | null = employerColumn ? null : 0;
  for (const m of text.matchAll(/\b(Capital|Cuprum|Habitat|PlanVital|Planvital|Provida|ProVida|Modelo|Uno|UNO)\s{2,}(\d+,\d+)\s*%\s+(\d+(?:,\d+)?)\s*%/g)) {
    const name = AFP_NAMES[m[1]!.toLowerCase()]!;
    if (rates[name] != null) continue;
    rates[name] = pct(m[2]!);
    if (employerColumn) {
      const e = pct(m[3]!);
      if (employerRate != null && employerRate !== e) throw new Error(`previred ${periodMonth}: employer rates differ across AFPs`);
      employerRate = e;
    }
  }
  // A commission change announced above the table («Cambio de Comisión AFP UNO … : 0,62%») for an
  // AFP the table does not list that month.
  for (const m of text.matchAll(/Cambio de Comisi[oó]n AFP\s+(\w+)[^:\n]*:\s*(\d+,\d+)\s*%/gi)) {
    const name = AFP_NAMES[m[1]!.toLowerCase()];
    if (name && rates[name] == null) rates[name] = 10 + pct(m[2]!);
  }
  if (Object.keys(rates).length < 5) throw new Error(`previred ${periodMonth}: only ${Object.keys(rates).length} AFP rates read`);
  if (employerRate == null) throw new Error(`previred ${periodMonth}: no employer rate in the employer column`);

  const afcM = /Plazo\s+Indefinido\s+(\d+,\d+)\s*%\s*R\.I\.\s+(\d+,\d+)\s*%\s*R\.I\./i.exec(text);
  if (!afcM) throw new Error(`previred ${periodMonth}: no indefinite-contract unemployment rates`);

  return {
    period_month: periodMonth,
    uf,
    utm: chileanAmount(utmM[1]!),
    pension_cap_uf: pct(capM[1]!),
    unemployment_cap_uf: pct(afcCapM[1]!),
    afp_worker_rates: rates,
    afp_employer_rate: employerRate,
    afc_worker_rate: pct(afcM[2]!),
    afc_employer_rate: pct(afcM[1]!),
  };
}

export function previredIndicatorsDir(): string {
  return path.join(resolveCfraserDir(), "previred-indicadores");
}

export function pdfText(file: string): string {
  return execFileSync("pdftotext", ["-layout", file, "-"], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
}

/** The staged PDFs (`<YYYY-MM>.pdf`), oldest first. */
export function stagedPreviredFiles(dir = previredIndicatorsDir()): { month: string; file: string }[] {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => /^\d{4}-\d{2}\.pdf$/.test(f))
    .sort()
    .map((f) => ({ month: f.slice(0, 7), file: path.join(dir, f) }));
}

/** The archive page's links: payroll month → PDF URL («<a href="…pdf">Enero 2018</a>»). */
export function previredArchiveLinks(html: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of html.matchAll(/<a href="([^"]+\.pdf)"[^>]*>\s*([A-Za-zé]+)\s+(\d{4})\s*<\/a>/g)) {
    const month = MONTHS[m[2]!.toLowerCase()];
    if (!month) throw new Error(`previred archive: unknown month «${m[2]}»`);
    out.set(ym(Number(m[3]), month), new URL(m[1]!, PREVIRED_ARCHIVE_URL).toString());
  }
  return out;
}
