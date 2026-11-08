import {
  cartolaStatementMonths,
  monthKeyFromYmd,
} from "./calendarMonth.js";
import { isCorpusPdfSourceKind } from "./ccStatementSourceKind.js";
import { parseDdMmYyToIso } from "nw-tracker-contracts";

function isoFromPeriodField(raw: string | null | undefined): string | null {
  const t = String(raw ?? "").trim();
  if (!t) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return t;
  return parseDdMmYyToIso(t);
}

/** `YYYY-MM` from `credit_card_statements.period_to` (billing cycle end). */
export function matrixMonthFromCcPeriodTo(periodTo: string | null | undefined): string | null {
  const iso = isoFromPeriodField(periodTo);
  return iso ? monthKeyFromYmd(iso) : null;
}

/** Matrix row month for a CC PDF statement; requires `period_to` (no fallbacks). */
export function matrixMonthForCcStatement(row: {
  period_to?: string | null;
  source_kind: string;
}): string | null {
  if (!isCorpusPdfSourceKind(row.source_kind)) return null;
  return matrixMonthFromCcPeriodTo(row.period_to);
}

/** `checking_cartola_imports.period_month` as stored in DB. */
export function matrixMonthForCartolaPeriodMonth(periodMonth: string): string | null {
  const t = String(periodMonth ?? "").trim();
  return /^\d{4}-\d{2}$/.test(t) ? t : null;
}

/** Every matrix month covered by a cartola (movements + statement month). */
export function matrixMonthsForCartolaPeriodRange(
  periodFrom: string | null | undefined,
  periodTo: string | null | undefined,
  fallbackPeriodMonth?: string | null,
  movements?: { occurred_on?: string }[]
): string[] {
  return cartolaStatementMonths({
    period_from: periodFrom,
    period_to: periodTo,
    period_month: fallbackPeriodMonth,
    movements,
  });
}

/** True when `rowMonth` matches the cartola import's `period_month`. */
export function cartolaPeriodRangeCoversMonth(
  row: {
    period_month?: string | null;
    period_from?: string | null;
    period_to?: string | null;
  },
  rowMonth: string
): boolean {
  const pm = matrixMonthForCartolaPeriodMonth(String(row.period_month ?? ""));
  return pm === rowMonth;
}
