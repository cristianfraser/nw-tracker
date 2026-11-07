/** A card line's merchant as the banks print it. */
import { collapseSpaces } from "./text.js";

/** Santander's web movements table (and the feed's pending rows) cut «Comercio» at this width. */
export const WEB_PASTE_MERCHANT_TRUNCATION_WIDTH = 15;

/**
 * The merchant text lines compare by: trimmed, upper case, single spaces. The Python parser's
 * `norm_merchant` (`parse-cc-statement-pdfs.py`) is the same rule.
 */
export function normalizeMerchantText(merchant: string | null | undefined): string {
  return collapseSpaces(String(merchant ?? "").toUpperCase());
}

/** BCI prints « (T)» after a merchant on its statement (not on the paste): «FARMACIA (T)» → «FARMACIA». */
export function stripBciTerminalSuffix(merchant: string): string {
  return merchant.replace(/\s*\(T\)\s*$/i, "");
}

/** Whether `short` is `long` as the web listing cut it: exactly the cut width and a prefix of it. */
export function isWebPasteCutOf(short: string, long: string): boolean {
  return short.length === WEB_PASTE_MERCHANT_TRUNCATION_WIDTH && long.length > short.length && long.startsWith(short);
}
