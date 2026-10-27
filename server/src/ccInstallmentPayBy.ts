/**
 * Due date («PAGAR HASTA») of a facturación.
 *
 * Order of resolution (same for import + any server-side recompute):
 * 1. **Explicit `pay_by`** printed on the statement (CSV column `pay_by`, DD/MM/YYYY) when non-empty —
 *    extracted in Python via `PAGAR\s+HASTA\s+(\d{2}/\d{2}/\d{4})` in `parse-cc-statement-pdfs.py`.
 * 2. **Derived from the close** by the issuer's rule (`CcDerivedPayByRule` on `CC_ISSUERS`): the
 *    **`statement_date`** («FECHA ESTADO DE CUENTA») is the close — BCI the 10th of the next month as
 *    it falls, Santander the 10th moved back to the previous Chile business day, CMR close + 16 days.
 *    The Chile holiday calendar only covers the years `marketHolidays.ts` lists, which is what a
 *    forward estimate needs; a historical statement carries its printed date.
 * 3. If `statement_date` is also empty, use **`period_to`** (DD/MM/YYYY) with the same rule.
 * 4. If neither is usable, use **`transaction_date`** / posting with the same rule as a last resort.
 */
import type { CcDerivedPayByRule } from "./ccIssuers.js";
import { isChileBusinessDay, priorChileBusinessDayYmd } from "./marketHolidays.js";

const DD_MM = /^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/;
/** pypdf can merge DD/MM/YY with MCC digits (e.g. 13/05/2511001SANTIAG). */
const TX_DATE_MAX_PLAUSIBLE_YEAR = 2038;

function normalizeTxDateDdMm(raw: string): string {
  const t = String(raw ?? "").trim();
  const m = DD_MM.exec(t);
  if (!m) return t;
  const ypart = m[3]!;
  if (ypart.length === 2) return t;
  const y = Number(ypart);
  if (y >= 1990 && y <= TX_DATE_MAX_PLAUSIBLE_YEAR) return t;
  return `${m[1]}/${m[2]}/${ypart.slice(0, 2)}`;
}

export function parseDdMmYyToIso(raw: string): string | null {
  const t = normalizeTxDateDdMm(String(raw ?? "").trim());
  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return t;
  const m = DD_MM.exec(t);
  if (!m) return null;
  const d = Number(m[1]);
  const mo = Number(m[2]);
  let y = Number(m[3]);
  if (y < 100) y += y >= 70 ? 1900 : 2000;
  if (!Number.isFinite(d) || !Number.isFinite(mo) || !Number.isFinite(y)) return null;
  if (d < 1 || d > 31 || mo < 1 || mo > 12) return null;
  return `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/** Next calendar month, then day `day` (clamped by JS Date rollover). */
export function nextMonthDayIso(anchorDdMmYyyy: string, day: number): string | null {
  const iso = parseDdMmYyToIso(anchorDdMmYyyy);
  if (!iso) return null;
  const [ys, ms] = iso.split("-");
  const y = Number(ys);
  const m0 = Number(ms) - 1;
  const d = new Date(Date.UTC(y, m0 + 1, day));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

function isoAddDays(iso: string, days: number): string {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y!, m! - 1, d! + days)).toISOString().slice(0, 10);
}

/**
 * The pay-by an issuer would print for a facturación that closed on `closeDdMmYyyyOrIso`, by its
 * rule (see `CcDerivedPayByRule`); null when the close does not parse.
 */
export function derivedPayByIso(closeDdMmYyyyOrIso: string, rule: CcDerivedPayByRule): string | null {
  if (rule.kind === "close_plus_days") {
    const iso = parseDdMmYyToIso(closeDdMmYyyyOrIso);
    return iso ? isoAddDays(iso, rule.days) : null;
  }
  const iso = nextMonthDayIso(closeDdMmYyyyOrIso, rule.day);
  if (!iso || !rule.prior_business_day || isChileBusinessDay(iso)) return iso;
  const prior = priorChileBusinessDayYmd(iso);
  if (!prior) throw new Error(`No Chile business day within two weeks before ${iso}`);
  return prior;
}

export function resolveInstallmentPayByIso(
  row: {
    pay_by?: string;
    statement_date?: string;
    period_to?: string;
    transaction_date?: string;
  },
  rule: CcDerivedPayByRule | (() => CcDerivedPayByRule)
): string | null {
  const explicit = String(row.pay_by ?? "").trim();
  if (explicit) {
    return parseDdMmYyToIso(explicit);
  }
  for (const anchor of [row.statement_date, row.period_to, row.transaction_date]) {
    const a = String(anchor ?? "").trim();
    if (a) return derivedPayByIso(a, typeof rule === "function" ? rule() : rule);
  }
  return null;
}

/**
 * ISO of a stored card date — a line's transaction or posting date, a statement's or a payment's
 * date (accepts `YYYY-MM-DD` or the parsers' `DD/MM/YY(YY)`). Goes through {@link parseDdMmYyToIso},
 * so a year jammed with MCC digits is repaired and a day or month out of range is null.
 */
export function normalizeTransactionDateIso(td: string | null | undefined): string | null {
  if (!td) return null;
  const t = String(td).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return t;
  return parseDdMmYyToIso(t);
}

/** ISO date of a statement line: its transaction date, else its posting date. */
export function statementLineDateIso(line: {
  transaction_date: string | null;
  posting_date: string | null;
}): string | null {
  return normalizeTransactionDateIso(line.transaction_date) ?? normalizeTransactionDateIso(line.posting_date);
}
