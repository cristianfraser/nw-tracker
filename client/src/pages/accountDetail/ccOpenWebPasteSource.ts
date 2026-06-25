import { ymCompare } from "../../calendarMonth";
import type { CcStatementDto } from "../../types";

export function isWebPasteStatementSource(sourcePdf: string): boolean {
  return String(sourcePdf ?? "").trim().startsWith("import:web-paste");
}

export function parseOpenWebPasteBillingMonth(sourcePdf: string): string | null {
  const m = /^import:web-paste\|open\|(\d{4}-\d{2})$/.exec(String(sourcePdf ?? "").trim());
  return m?.[1] ?? null;
}

function hasPdfStatementCloseForMonth(
  statements: readonly CcStatementDto[],
  billingMonth: string
): boolean {
  return statements.some(
    (st) => st.billing_month === billingMonth && !isWebPasteStatementSource(st.source_pdf)
  );
}

/** Statements whose lines belong in a facturación month modal / line list. */
export function statementsForFacturacionMonth(
  statements: readonly CcStatementDto[],
  billingMonth: string
): CcStatementDto[] {
  const pdfClosed = hasPdfStatementCloseForMonth(statements, billingMonth);
  return statements.filter((st) => {
    const bucketBm = parseOpenWebPasteBillingMonth(st.source_pdf);
    if (bucketBm != null) {
      if (pdfClosed && st.billing_month === billingMonth) return false;
      if (ymCompare(bucketBm, billingMonth) < 0) return true;
      return st.billing_month === billingMonth;
    }
    if (pdfClosed) {
      return st.billing_month === billingMonth && !isWebPasteStatementSource(st.source_pdf);
    }
    return st.billing_month === billingMonth;
  });
}
