import { normalizeMerchantText } from "nw-tracker-contracts";

/**
 * A merchant as two renderings of one statement agree on it: the statement JSON keeps an
 * Argentine acquirer's terminal code that the PDF parse drops («KIOSCO 1234» / «KIOSCO») and
 * renders some punctuation differently («ABC] 12 CENTRO» / «ABC! 12 CENTRO»). Read by the JSON↔PDF
 * cross-check (`cardStatementCrossCheck.ts`) and by a source takeover of one close
 * (`statementLinePlan.ts`).
 */
export function merchantRenderingKey(value: string): string {
  return normalizeMerchantText(value)
    .replace(/ \d{4}$/, "")
    .replace(/[^A-Z0-9 ]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}
