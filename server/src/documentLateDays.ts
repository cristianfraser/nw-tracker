import { addCalendarMonths } from "nw-tracker-contracts";
import type { ImportSyncDocumentKind } from "./importSyncDocumentTypes.js";

/**
 * The day each monthly document is late from. A leaf module (no db, no scheduler) so the late-document
 * check and the Fintual retiro deadline share one rule without importing each other.
 */

/** Cartola mails come in the first weeks of the next month; by the 25th one is overdue. */
export const CARTOLA_LATE_DAY = 25;
/** The matrix month is the close's month; closes fall late in the month and the mail follows by 2–3 days. */
export const CARD_STATEMENT_LATE_DAY = 7;

/** The day a month's document of this kind is late from (`YYYY-MM-DD`, in the following month). */
export function documentLateOn(kind: ImportSyncDocumentKind, month: string): string {
  const day = kind === "cc_statement" ? CARD_STATEMENT_LATE_DAY : CARTOLA_LATE_DAY;
  return `${addCalendarMonths(month, 1)}-${String(day).padStart(2, "0")}`;
}
