/**
 * The source name of a card's open web-paste bucket (`import:web-paste|open|<YYYY-MM>`): built
 * and read here (a leaf; `ccOpenWebPasteRepair.ts` re-exports it).
 */
export const OPEN_WEB_PASTE_SOURCE_PREFIX = "import:web-paste|open|";

export function openWebPasteSourcePdf(billingMonth: string): string {
  return `${OPEN_WEB_PASTE_SOURCE_PREFIX}${billingMonth}`;
}

export function parseOpenWebPasteBillingMonth(sourcePdf: string): string | null {
  const m = /^import:web-paste\|open\|(\d{4}-\d{2})$/.exec(String(sourcePdf ?? "").trim());
  return m?.[1] ?? null;
}
