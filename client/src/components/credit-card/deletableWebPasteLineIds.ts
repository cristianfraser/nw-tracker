import type { CcStatementDto } from "../../types";

/** Statement line ids on open web-paste buckets for one billing month. */
export function deletableWebPasteLineIds(
  statements: readonly CcStatementDto[],
  billingMonth: string
): Set<number> {
  const ids = new Set<number>();
  for (const st of statements) {
    if (!String(st.source_pdf).startsWith("import:web-paste")) continue;
    if (st.billing_month !== billingMonth) continue;
    for (const ln of st.lines) ids.add(ln.id);
  }
  return ids;
}
