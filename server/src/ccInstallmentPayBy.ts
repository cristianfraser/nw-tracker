/**
 * Due date (“pagar hasta”) for installment rows parsed from Banco de Chile PDFs.
 *
 * Order of resolution (same for import + any server-side recompute):
 * 1. **Explicit `pay_by`** from the statement (CSV column `pay_by`, DD/MM/YYYY) when non-empty —
 *    extracted in Python via `PAGAR\s+HASTA\s+(\d{2}/\d{2}/\d{4})` in `parse-cc-statement-pdfs.py`.
 * 2. **Fallback** when the PDF extract did not surface `pay_by`: take **`statement_date`**
 *    (“FECHA ESTADO DE CUENTA”, DD/MM/YYYY) and use the **10th calendar day of the immediately following month**.
 *    Banco de Chile typically bills around the last third of the month with due ~9–10 of the next month; we fix
 *    day **10** for consistency when `pay_by` is missing.
 * 3. If `statement_date` is also empty, use **`period_to`** (DD/MM/YYYY) with the same “next month, day 10” rule.
 * 4. If neither is usable, use **`transaction_date`** / posting with the same rule as a last resort.
 */

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

export function resolveInstallmentPayByIso(row: {
  pay_by?: string;
  statement_date?: string;
  period_to?: string;
  transaction_date?: string;
}): string | null {
  const explicit = String(row.pay_by ?? "").trim();
  if (explicit) {
    return parseDdMmYyToIso(explicit);
  }
  const st = String(row.statement_date ?? "").trim();
  if (st) {
    return nextMonthDayIso(st, 10);
  }
  const pto = String(row.period_to ?? "").trim();
  if (pto) {
    return nextMonthDayIso(pto, 10);
  }
  const tx = String(row.transaction_date ?? "").trim();
  if (tx) {
    return nextMonthDayIso(tx, 10);
  }
  return null;
}
