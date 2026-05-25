import { monthKeyFromYmd } from "./calendarMonth.js";
import { parseDdMmYyToIso } from "./ccInstallmentPayBy.js";

function isoFromPeriodField(raw: string | null | undefined): string | null {
  const t = String(raw ?? "").trim();
  if (!t) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return t;
  return parseDdMmYyToIso(t);
}

/** Real imported statement PDF (excludes web-paste / manual movement buckets). */
export function isCcStatementPdfSource(sourcePdf: string | null | undefined): boolean {
  const t = String(sourcePdf ?? "").trim();
  return t.length > 0 && !t.startsWith("import:web-paste");
}

/** `YYYY-MM` from `credit_card_statements.period_to` (billing cycle end). */
export function matrixMonthFromCcPeriodTo(periodTo: string | null | undefined): string | null {
  const iso = isoFromPeriodField(periodTo);
  return iso ? monthKeyFromYmd(iso) : null;
}

/** Matrix row month for a CC PDF statement; requires `period_to` (no fallbacks). */
export function matrixMonthForCcStatement(row: {
  period_to?: string | null;
  source_pdf?: string | null;
}): string | null {
  if (!isCcStatementPdfSource(row.source_pdf)) return null;
  return matrixMonthFromCcPeriodTo(row.period_to);
}

/** `checking_cartola_imports.period_month` as stored in DB. */
export function matrixMonthForCartolaPeriodMonth(periodMonth: string): string | null {
  const t = String(periodMonth ?? "").trim();
  return /^\d{4}-\d{2}$/.test(t) ? t : null;
}
