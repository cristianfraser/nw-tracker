// Copy of `parseDdMmYyToIso` (server/src/ccInstallmentPayBy.ts) for the parsers that moved to
// ingest (docs/ingest-split-plan.md); both are pinned by server/src/test/ddMmYyToIsoCases.json.

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

/** `dd/mm/yyyy` or `dd/mm/yy` (or an ISO date, as is) → `YYYY-MM-DD`; null when it is neither. */
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
