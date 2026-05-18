import fs from "node:fs";
import path from "node:path";
import * as XLSX from "xlsx";
import { resolveCfraserCsvDir } from "./cfraserPaths.js";
import { numCsv } from "./deptoDividendosLedger.js";

/** One paid installment row from the bank “Dividendos Históricos” export. */
export type BankDividendoRow = {
  cuota_num: string;
  occurred_on: string;
  total_clp: number;
  amortizacion_clp: number | null;
  interes_clp: number | null;
  incendio_clp: number | null;
  desgravamen_clp: number | null;
  total_seguros_clp: number | null;
};

function parseBankDate(s: string): string | null {
  const t = String(s ?? "").trim();
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(t);
  if (!m) return null;
  const d = Number(m[1]);
  const mo = Number(m[2]);
  const y = Number(m[3]);
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  return `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

function clpFromCell(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return Math.round(v);
  return numCsv(v);
}

/**
 * Bank file: `Dividendos Históricos` xlsx (Santander-style export).
 * Env `BANK_DIVIDENDOS_XLSX` or `cfraser/dividendos-historicos-banco.xlsx`.
 */
export function resolveBankDividendosHistoricosPath(): string | null {
  const env = process.env.BANK_DIVIDENDOS_XLSX?.trim();
  if (env && fs.existsSync(env)) return env;
  const candidates = [
    path.join(resolveCfraserCsvDir(), "dividendos-historicos-banco.xlsx"),
    path.join(resolveCfraserCsvDir(), "Dividendos_Historicos_banco.xlsx"),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

export function loadBankDividendosHistoricos(filePath: string): BankDividendoRow[] {
  if (!fs.existsSync(filePath)) return [];
  const buf = fs.readFileSync(filePath);
  const wb = XLSX.read(buf, { type: "buffer", cellDates: false });
  const sheet = wb.Sheets[wb.SheetNames[0]!];
  if (!sheet) return [];
  const grid = XLSX.utils.sheet_to_json<(string | number)[]>(sheet, { header: 1, defval: "" });
  if (grid.length < 2) return [];
  const out: BankDividendoRow[] = [];
  for (let i = 1; i < grid.length; i++) {
    const row = grid[i] ?? [];
    const cuotaRaw = String(row[0] ?? "").trim();
    if (!/^\d+$/.test(cuotaRaw)) continue;
    const paidOn = parseBankDate(String(row[3] ?? ""));
    const total = clpFromCell(row[4]);
    if (!paidOn || total == null || !Number.isFinite(total)) continue;
    out.push({
      cuota_num: cuotaRaw,
      occurred_on: paidOn,
      total_clp: total,
      amortizacion_clp: clpFromCell(row[8]),
      interes_clp: clpFromCell(row[9]),
      incendio_clp: clpFromCell(row[6]),
      total_seguros_clp: clpFromCell(row[7]),
      desgravamen_clp: clpFromCell(row[10]),
    });
  }
  return out;
}

export function enrichDeptoSheetRowFromBank(
  sheet: {
    cuota: string;
    occurred_on: string;
    amortizacion_clp: number | null;
    interes_clp: number | null;
    incendio_clp: number | null;
    desgravamen_clp: number | null;
    total_seguros_clp: number | null;
  },
  bank: BankDividendoRow
): void {
  const cuotaMatch = sheet.cuota === bank.cuota_num || sheet.cuota.trim() === bank.cuota_num;
  if (!cuotaMatch) return;
  if (sheet.amortizacion_clp == null && bank.amortizacion_clp != null) {
    sheet.amortizacion_clp = bank.amortizacion_clp;
  }
  if (sheet.interes_clp == null && bank.interes_clp != null) {
    sheet.interes_clp = bank.interes_clp;
  }
  if (sheet.incendio_clp == null && bank.incendio_clp != null) {
    sheet.incendio_clp = bank.incendio_clp;
  }
  if (sheet.desgravamen_clp == null && bank.desgravamen_clp != null) {
    sheet.desgravamen_clp = bank.desgravamen_clp;
  }
  if (sheet.total_seguros_clp == null && bank.total_seguros_clp != null) {
    sheet.total_seguros_clp = bank.total_seguros_clp;
  }
}

export function enrichDeptoLedgerFromBankFile(
  ledger: {
    cuota: string;
    occurred_on: string;
    amortizacion_clp: number | null;
    interes_clp: number | null;
    incendio_clp: number | null;
    desgravamen_clp: number | null;
    total_seguros_clp: number | null;
  }[],
  bankPath: string | null
): number {
  if (!bankPath) return 0;
  const bankRows = loadBankDividendosHistoricos(bankPath);
  if (bankRows.length === 0) return 0;
  const byCuotaDate = new Map<string, BankDividendoRow>();
  for (const b of bankRows) {
    byCuotaDate.set(`${b.cuota_num}|${b.occurred_on}`, b);
  }
  let n = 0;
  for (const s of ledger) {
    if (!/^\d+$/.test(String(s.cuota).trim())) continue;
    const b =
      byCuotaDate.get(`${s.cuota.trim()}|${s.occurred_on}`) ??
      bankRows.find((x) => x.cuota_num === s.cuota.trim());
    if (!b) continue;
    enrichDeptoSheetRowFromBank(s, b);
    n += 1;
  }
  return n;
}
