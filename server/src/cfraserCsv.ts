/**
 * Helpers for Numbers-exported CSVs under cfraser/ (semicolon-separated, es-CL numbers).
 */

import fs from "node:fs";
import type { Statement } from "better-sqlite3";

export type MonthKey = string;

export function monthKey(d: Date): MonthKey {
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth() + 1;
  return `${y}-${String(m).padStart(2, "0")}`;
}

export function asOfDate(mk: MonthKey): string {
  return `${mk}-01`;
}

/** Last calendar day of month (UTC), `YYYY-MM-DD` — for position / EOD lookup. */
export function monthEndDate(mk: MonthKey): string {
  const [ys, ms] = mk.split("-");
  const y = Number(ys);
  const mo = Number(ms);
  if (!Number.isFinite(y) || !Number.isFinite(mo) || mo < 1 || mo > 12) return `${mk}-01`;
  return new Date(Date.UTC(y, mo, 0)).toISOString().slice(0, 10);
}

/** Parses "Jun 17", "Mar 26" (20xx inferred: <=30 → 2000+y else 1900+y) */
export function parseSheetMonthCell(raw: string): Date | null {
  const s = raw?.trim();
  if (!s) return null;
  const m = /^([A-Za-z]{3})\s+(\d{2})$/.exec(s);
  if (!m) return null;
  const mon = "jan feb mar apr may jun jul aug sep oct nov dec".split(" ").indexOf(m[1].toLowerCase());
  if (mon < 0) return null;
  const yy = Number(m[2]);
  const year = yy <= 30 ? 2000 + yy : 1900 + yy;
  return new Date(Date.UTC(year, mon, 1));
}

export function numCsv(v: unknown): number | null {
  if (v == null) return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  const s = String(v).trim();
  if (!s) return null;
  const neg = s.includes("(") && s.includes(")");
  const t = s
    .replace(/^\ufeff/, "")
    .replace(/US\$/gi, "")
    .replace(/[$\sUF\u00a0\u202f\u2007]/gi, "")
    .replace(/\./g, "")
    .replace(/,/g, ".")
    .replace(/[()]/g, "");
  const n = Number(t);
  if (!Number.isFinite(n)) return null;
  return neg ? -n : n;
}

/**
 * USD amounts written with a dot as the decimal separator (`612.36`, `US$ 1.53`).
 * Use this for hand-edited `stocks-lots.csv` USD cells — {@link numCsv} would treat `612.36` as `61236`.
 */
export function numUsdDotDecimal(v: unknown): number | null {
  if (v == null || v === "") return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  const s = String(v).trim();
  if (!s) return null;
  const neg = s.includes("(") && s.includes(")");
  const core = s.replace(/US\$/gi, "").replace(/[$\s]/g, "").replace(/[()]/g, "");
  if (!/^-?\d+(\.\d+)?$/.test(core)) return null;
  const n = Number(core);
  if (!Number.isFinite(n)) return null;
  return neg ? -n : n;
}

export function readSemicolonCsv(filePath: string): string[][] {
  if (!fs.existsSync(filePath)) return [];
  const text = fs.readFileSync(filePath, "utf8");
  const lines = text.split(/\r?\n/);
  return lines.map((line) => line.split(";"));
}

/** `movements` insert shape used by `import:excel` (optional `units_delta`). */
export type ExcelMovementInsertStmt = Statement<[number, number, string, string, number | null]>;

/** Inserts one signed CLP movement (positive inflow, negative outflow). */
export function emitSignedMonthlyMovement(
  ins: ExcelMovementInsertStmt,
  accountId: number,
  amount: number | null,
  occurredOn: string,
  note: string,
  unitsDelta: number | null = null
) {
  if (amount == null || !Number.isFinite(amount) || amount === 0) return;
  ins.run(accountId, amount, occurredOn, note, unitsDelta);
}
