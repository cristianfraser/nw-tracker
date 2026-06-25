import type { CcStatementDto } from "../../types";
import {
  isWebPasteStatementSource,
  statementsForFacturacionMonth,
} from "../../pages/accountDetail/ccOpenWebPasteSource";

/** Statement line ids on open web-paste buckets for one billing month. */
export function deletableWebPasteLineIds(
  statements: readonly CcStatementDto[],
  billingMonth: string
): Set<number> {
  const ids = new Set<number>();
  for (const st of statementsForFacturacionMonth(statements, billingMonth)) {
    if (!isWebPasteStatementSource(st.source_pdf)) continue;
    for (const ln of st.lines) ids.add(ln.id);
  }
  return ids;
}
