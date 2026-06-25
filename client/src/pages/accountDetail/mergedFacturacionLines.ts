import type { CcStatementDto, CcStatementLineDto } from "../../types";
import { statementsForFacturacionMonth } from "./ccOpenWebPasteSource";

export type MergedFacturacionLine = CcStatementLineDto & {
  currency: "clp" | "usd";
  statement_id: number;
};

function parseLineSortKey(raw: string | null | undefined): number {
  const s = String(raw ?? "").trim();
  if (!s) return 0;
  const ddmm = /^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/.exec(s);
  if (ddmm) {
    let y = Number(ddmm[3]);
    if (y < 100) y += y >= 70 ? 1900 : 2000;
    const mo = Number(ddmm[2]) - 1;
    const d = Number(ddmm[1]);
    return Date.UTC(y, mo, d);
  }
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (iso) {
    return Date.UTC(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3]));
  }
  return 0;
}

export function mergedFacturacionLines(
  statements: readonly CcStatementDto[],
  billingMonth: string
): MergedFacturacionLine[] {
  const out: MergedFacturacionLine[] = [];
  for (const st of statementsForFacturacionMonth(statements, billingMonth)) {
    const currency = st.currency === "usd" ? "usd" : "clp";
    for (const ln of st.lines) {
      out.push({ ...ln, currency, statement_id: st.id });
    }
  }
  out.sort((a, b) => {
    const da =
      parseLineSortKey(a.transaction_date) ||
      parseLineSortKey(a.posting_date);
    const db =
      parseLineSortKey(b.transaction_date) ||
      parseLineSortKey(b.posting_date);
    if (da !== db) return da - db;
    if (a.currency !== b.currency) return a.currency.localeCompare(b.currency);
    return a.id - b.id;
  });
  return out;
}
