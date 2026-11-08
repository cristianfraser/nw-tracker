/** What a nota de crédito is, and how far after a purchase it may annul it (leaf: the plan ledger and the expense pairing read it). */
import { monthKeyFromYmd } from "../calendarMonth.js";

/** Below this CLP amount, NOTA DE CREDITO is an unmatched gastos adjustment (no purchase match). At or above, unmatched lines are abonos. */
export const NOTA_DE_CREDITO_MATCH_MIN_CLP = 10_000;

/** Max calendar months after purchase month for a NOTA DE CREDITO to annul an installment purchase. */
export const NOTA_DE_CREDITO_MAX_CALENDAR_MONTHS_AFTER_PURCHASE = 2;

/** Calendar months from purchase month to nota month (0 = same month). */
export function calendarMonthsAfterPurchase(purchaseIso: string, notaIso: string): number {
  const purchaseYm = monthKeyFromYmd(purchaseIso);
  const notaYm = monthKeyFromYmd(notaIso);
  if (!purchaseYm || !notaYm) return Number.POSITIVE_INFINITY;
  const py = Number(purchaseYm.slice(0, 4));
  const pm = Number(purchaseYm.slice(5, 7));
  const ny = Number(notaYm.slice(0, 4));
  const nm = Number(notaYm.slice(5, 7));
  return (ny - py) * 12 + (nm - pm);
}

export function isNotaDeCreditoMerchant(merchant: string | null | undefined): boolean {
  return /\bNOTA\s+DE\s+CREDITO\b/i.test(String(merchant ?? "").trim());
}
