import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import XLSX from "xlsx";
import { expandYearMonthsInclusive, ymCompare } from "./calendarMonth.js";
import { monthKey, type MonthKey } from "./cfraserCsv.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..");

export const PRE2020_SYNTHETIC_FIRST_MONTH = "2017-06";
export const PRE2020_SYNTHETIC_LAST_MONTH = "2019-12";

const TABLE_121_SHEET = "net worth - Table 1-2-1";
const CUENTA_COL = 2;

type Row = (string | number | Date | null | undefined)[];

function num(v: unknown): number | null {
  if (v == null || v === "") return null;
  if (typeof v === "number") return Number.isFinite(v) ? Math.round(v) : null;
  if (typeof v === "string") {
    const t = v.replace(/[$\s]/g, "").replace(/\./g, "").replace(/,/g, ".");
    const n = Number(t);
    return Number.isFinite(n) ? Math.round(n) : null;
  }
  return null;
}

export function resolveCfraserExcelPath(): string {
  const env = process.env.EXCEL_PATH?.trim();
  if (env) return path.resolve(env);
  return path.join(REPO_ROOT, "cfraser.xlsx");
}

/** Month-end cuenta corriente balances from Table 1-2-1 (Numbers legacy). */
export function loadPre2020CheckingExcelBalances(
  excelPath = resolveCfraserExcelPath()
): Map<MonthKey, number> {
  if (!fs.existsSync(excelPath)) {
    throw new Error(`Excel not found: ${excelPath}`);
  }
  const buf = fs.readFileSync(excelPath);
  const wb = XLSX.read(buf, { type: "buffer", cellDates: true });
  const sh = wb.Sheets[TABLE_121_SHEET];
  if (!sh) {
    throw new Error(`Sheet not found: ${TABLE_121_SHEET}`);
  }
  const rows = XLSX.utils.sheet_to_json<Row>(sh, { header: 1, defval: null, raw: true }) as Row[];

  const out = new Map<MonthKey, number>();
  for (const row of rows) {
    const d = row[0];
    if (!(d instanceof Date) || Number.isNaN(d.getTime())) continue;
    const mk = monthKey(d);
    if (ymCompare(mk, PRE2020_SYNTHETIC_FIRST_MONTH) < 0) continue;
    if (ymCompare(mk, PRE2020_SYNTHETIC_LAST_MONTH) > 0) continue;
    const balance = num(row[CUENTA_COL]);
    if (balance == null) continue;
    out.set(mk, balance);
  }
  return out;
}

export function pre2020SyntheticMonthKeys(): MonthKey[] {
  return expandYearMonthsInclusive(PRE2020_SYNTHETIC_FIRST_MONTH, PRE2020_SYNTHETIC_LAST_MONTH);
}

export function previousMonthKey(mk: MonthKey): MonthKey | null {
  const months = pre2020SyntheticMonthKeys();
  const i = months.indexOf(mk);
  if (i <= 0) return null;
  return months[i - 1] ?? null;
}
