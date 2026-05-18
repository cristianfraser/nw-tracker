import {
  DEPTO_PAYMENT_SCENARIO_TERMS,
  firstDeptoMortgagePaymentYmd,
  type DeptoMortgageSheetRow,
  type DeptoPaymentScenarioCell,
  type DeptoPaymentScenarioRow,
  type DeptoPaymentScenarioTerm,
  isDeptoMortgagePaymentCuota,
  numCsv,
  readSemicolonCsv,
} from "./deptoDividendosLedger.js";
import { chileCalendarTodayYmd } from "./chileDate.js";
import { ufRowOnOrBefore } from "./fxRates.js";
import path from "node:path";

/** Model annual rate (4,95%) — monthly = /12/100. */
const DEFAULT_ANNUAL_RATE = 0.0495;

/** Mortgage installments are scheduled on this day of each month (display + UF día lookup). */
export const MORTGAGE_PAYMENT_DAY_OF_MONTH = 11;

const TERM_PLAZO_MESES: Record<DeptoPaymentScenarioTerm, number> = {
  30: 360,
  25: 300,
  20: 240,
  15: 180,
  12: 144,
  10: 120,
  5: 60,
  max: 60,
};

const SCENARIO_UF_COL: Record<DeptoPaymentScenarioTerm, number> = {
  30: 24,
  25: 25,
  20: 26,
  15: 27,
  12: 28,
  10: 29,
  5: 30,
  max: 31,
};

function roundUf5(v: number): number {
  return Math.round(v * 1e5) / 1e5;
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

function parseYmd(ymd: string): { y: number; m: number; d: number } | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd.trim());
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (!Number.isFinite(y) || mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  return { y, m: mo, d };
}

function addCalendarMonths(year: number, month: number, delta: number): { y: number; m: number } {
  const dt = new Date(Date.UTC(year, month - 1 + delta, 1));
  return { y: dt.getUTCFullYear(), m: dt.getUTCMonth() + 1 };
}

/** `YYYY-MM-11` for the calendar month of `ymd` (any day in that month). */
export function mortgageScheduleYmdInMonth(ymd: string): string | null {
  const p = parseYmd(ymd);
  if (!p) return null;
  return `${p.y}-${pad2(p.m)}-${pad2(MORTGAGE_PAYMENT_DAY_OF_MONTH)}`;
}

/** First schedule anchor: day 11 in the month of the first mortgage payment. */
export function firstMortgageScheduleYmd(ledger: readonly { cuota: string; occurred_on: string }[]): string | null {
  const first = firstDeptoMortgagePaymentYmd(ledger);
  if (!first) return null;
  return mortgageScheduleYmdInMonth(first);
}

/** Schedule date for numeric cuota `N` (day 11, counting from first numeric cuota). */
export function mortgageScheduleYmdForCuota(
  firstScheduleYmd: string,
  firstCuotaNum: number,
  cuotaNum: number
): string | null {
  const anchor = parseYmd(firstScheduleYmd);
  if (!anchor || !Number.isFinite(cuotaNum) || !Number.isFinite(firstCuotaNum)) return null;
  const offset = cuotaNum - firstCuotaNum;
  if (offset < 0) return null;
  const { y, m } = addCalendarMonths(anchor.y, anchor.m, offset);
  return `${y}-${pad2(m)}-${pad2(MORTGAGE_PAYMENT_DAY_OF_MONTH)}`;
}

/**
 * Next installment on the schedule relative to Chile today:
 * - before the 11th → this month's 11th;
 * - on/after the 11th → next month's 11th.
 */
export function nextMortgagePaymentScheduleYmd(todayYmd: string = chileCalendarTodayYmd()): string | null {
  const p = parseYmd(todayYmd);
  if (!p) return null;
  if (p.d < MORTGAGE_PAYMENT_DAY_OF_MONTH) {
    return `${p.y}-${pad2(p.m)}-${pad2(MORTGAGE_PAYMENT_DAY_OF_MONTH)}`;
  }
  const next = addCalendarMonths(p.y, p.m, 1);
  return `${next.y}-${pad2(next.m)}-${pad2(MORTGAGE_PAYMENT_DAY_OF_MONTH)}`;
}

function numericCuota(cuota: string): number | null {
  const n = parseInt(String(cuota).trim(), 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function paymentNumber(cuota: string, monthsPaid: number): number {
  return numericCuota(cuota) ?? monthsPaid;
}

function insuranceUfFromRow(row: DeptoMortgageSheetRow): number {
  if (row.total_seguros_uf != null && Number.isFinite(row.total_seguros_uf)) {
    return row.total_seguros_uf;
  }
  return (row.incendio_uf ?? 0) + (row.desgravamen_uf ?? 0);
}

function balanceUfBeforePayment(row: DeptoMortgageSheetRow): number | null {
  const after = row.credito_restante_uf;
  if (after == null || !Number.isFinite(after)) return null;
  const amort = (row.amortizacion_uf ?? 0) + (row.amortizacion_ext_uf ?? 0);
  return roundUf5(after + amort);
}

function balanceUfForNextPayment(row: DeptoMortgageSheetRow): number | null {
  const after = row.credito_restante_uf;
  if (after == null || !Number.isFinite(after)) return null;
  return roundUf5(after);
}

/** French amortization P+I+seguros (UF) — matches Numbers `K36*r/(1-(1+r)^-n)+AY`. */
export function computeMortgageScenarioPaymentUf(
  balanceUfBefore: number,
  plazoMesesTotal: number,
  paymentNum: number,
  insuranceUf: number,
  annualRate: number = DEFAULT_ANNUAL_RATE
): number | null {
  if (!Number.isFinite(balanceUfBefore) || balanceUfBefore <= 0) return null;
  if (plazoMesesTotal < paymentNum) return null;
  const remaining = plazoMesesTotal - paymentNum + 3;
  if (remaining <= 0) return null;
  const r = annualRate / 12;
  const denom = 1 - Math.pow(1 + r, -remaining);
  if (denom <= 1e-12) return null;
  return roundUf5((balanceUfBefore * r) / denom + insuranceUf);
}

function manualUfFromCsv(rawRow: string[], term: DeptoPaymentScenarioTerm): number | null {
  const v = numCsv(rawRow[SCENARIO_UF_COL[term]]);
  return v != null && Number.isFinite(v) ? roundUf5(v) : null;
}

function scenarioCell(
  term: DeptoPaymentScenarioTerm,
  rawRow: string[],
  sheetRow: DeptoMortgageSheetRow,
  monthsPaid: number,
  scheduleYmd: string,
  opts: { isNext: boolean }
): DeptoPaymentScenarioCell {
  const plazo = TERM_PLAZO_MESES[term];
  const paymentNum = paymentNumber(sheetRow.cuota, monthsPaid);
  const manualUf = opts.isNext ? null : manualUfFromCsv(rawRow, term);
  const ufRow = ufRowOnOrBefore(scheduleYmd);
  const ufClpDay = ufRow?.clp_per_uf ?? null;
  let paymentUf: number | null = null;
  if (plazo < paymentNum) {
    paymentUf = null;
  } else if (manualUf != null) {
    paymentUf = manualUf;
  } else {
    const bal = opts.isNext ? balanceUfForNextPayment(sheetRow) : balanceUfBeforePayment(sheetRow);
    if (bal != null) {
      paymentUf = computeMortgageScenarioPaymentUf(bal, plazo, paymentNum, insuranceUfFromRow(sheetRow));
    }
  }
  const paymentClp =
    paymentUf != null && ufClpDay != null && Number.isFinite(ufClpDay)
      ? Math.round(paymentUf * ufClpDay)
      : null;
  return { term, payment_uf: paymentUf, payment_clp: paymentClp };
}

function buildScenarioRow(
  scheduleYmd: string,
  cuotaLabel: string,
  sheetRow: DeptoMortgageSheetRow,
  monthsPaid: number,
  rawRow: string[],
  opts: { isNext: boolean }
): DeptoPaymentScenarioRow {
  const scenarios: DeptoPaymentScenarioCell[] = [];
  for (const term of DEPTO_PAYMENT_SCENARIO_TERMS) {
    scenarios.push(scenarioCell(term, rawRow, sheetRow, monthsPaid, scheduleYmd, opts));
  }
  scenarios.push(scenarioCell("max", rawRow, sheetRow, monthsPaid, scheduleYmd, opts));
  const minCell = scenarios.find((s) => s.term === 30)!;
  return {
    occurred_on: scheduleYmd,
    cuota: cuotaLabel,
    min_payment_uf: minCell.payment_uf,
    min_payment_clp: minCell.payment_clp,
    scenarios: scenarios.filter((s) => s.term !== 30),
    ...(opts.isNext ? { is_next_payment: true } : {}),
  };
}

/**
 * Reference payment scenarios on the mortgage schedule (day 11 each month).
 * UF from sheet when present; otherwise amortization formula. CLP = UF × uf_daily on schedule date.
 * Appends a projected next-payment row at the end (shown first in the UI).
 */
export function buildDeptoPaymentScenarioRows(
  cfraserDir: string,
  ledger: readonly DeptoMortgageSheetRow[]
): DeptoPaymentScenarioRow[] {
  const firstSchedule = firstMortgageScheduleYmd(ledger);
  if (!firstSchedule) return [];

  const fp = path.join(cfraserDir, "depto-dividendos.csv");
  const csvRows = readSemicolonCsv(fp);
  const byDateCuota = new Map<string, string[]>();
  for (let i = 3; i < csvRows.length; i++) {
    const raw = csvRows[i] ?? [];
    const occurred_on = String(raw[1] ?? "")
      .trim()
      .replace(/^\ufeff/, "");
    const cuota = String(raw[0] ?? "").trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(occurred_on)) continue;
    byDateCuota.set(`${occurred_on}|${cuota}`, raw);
  }

  const paymentRows = [...ledger]
    .filter((r) => isDeptoMortgagePaymentCuota(r.cuota))
    .sort((a, b) => {
      const c = a.occurred_on.localeCompare(b.occurred_on);
      return c !== 0 ? c : a.cuota.localeCompare(b.cuota);
    });

  const numericRows = paymentRows.filter((r) => numericCuota(r.cuota) != null);
  if (numericRows.length === 0) return [];

  const firstCuotaNum = numericCuota(numericRows[0]!.cuota)!;
  const nextScheduleYmd = nextMortgagePaymentScheduleYmd();
  if (!nextScheduleYmd) return [];

  const historical: DeptoPaymentScenarioRow[] = [];
  let monthsPaid = 0;
  for (const sheetRow of numericRows) {
    const cuotaNum = numericCuota(sheetRow.cuota)!;
    const scheduleYmd = mortgageScheduleYmdForCuota(firstSchedule, firstCuotaNum, cuotaNum);
    if (!scheduleYmd || scheduleYmd >= nextScheduleYmd) continue;
    monthsPaid += 1;
    const raw = byDateCuota.get(`${sheetRow.occurred_on}|${sheetRow.cuota}`) ?? [];
    historical.push(
      buildScenarioRow(scheduleYmd, sheetRow.cuota, sheetRow, monthsPaid, raw, { isNext: false })
    );
  }

  const lastPaid = numericRows[numericRows.length - 1]!;
  const lastCuotaNum = numericCuota(lastPaid.cuota)!;
  const nextCuotaNum = lastCuotaNum + 1;
  const nextRow = buildScenarioRow(
    nextScheduleYmd,
    String(nextCuotaNum),
    { ...lastPaid, cuota: String(nextCuotaNum) },
    monthsPaid + 1,
    [],
    { isNext: true }
  );

  return [...historical, nextRow];
}
