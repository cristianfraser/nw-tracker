import { monthKeyFromYmd } from "./calendarMonth.js";
import { countsTowardCcExpenseGastosMes } from "./ccExpenseCategories.js";
import type { FlowCcExpenseLineRowDraft } from "./flowsCreditCardExpenses.js";

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

export type NotaDeCreditoRole =
  | "annulled_purchase"
  | "matched_nota"
  | "unmatched_nota";

export type NotaDeCreditoPairingResult = {
  annulledPurchaseIds: Set<number>;
  matchedNotaIds: Set<number>;
  unmatchedNotaIds: Set<number>;
};

export function isNotaDeCreditoMerchant(merchant: string | null | undefined): boolean {
  return /\bNOTA\s+DE\s+CREDITO\b/i.test(String(merchant ?? "").trim());
}

function linePurchaseDateIso(line: FlowCcExpenseLineRowDraft): string {
  return line.purchase_on ?? line.occurred_on;
}

function isNotaDeCreditoLine(line: FlowCcExpenseLineRowDraft): boolean {
  return line.source === "cc" && isNotaDeCreditoMerchant(line.merchant) && line.amount_clp < 0;
}

function isPurchaseMatchCandidate(line: FlowCcExpenseLineRowDraft): boolean {
  return line.source === "cc" && line.amount_clp > 0;
}

export function pairNotaDeCreditoAnnulments(
  lines: readonly FlowCcExpenseLineRowDraft[]
): NotaDeCreditoPairingResult {
  const annulledPurchaseIds = new Set<number>();
  const matchedNotaIds = new Set<number>();
  const unmatchedNotaIds = new Set<number>();

  const usedPurchaseIds = new Set<number>();

  const purchases = lines
    .filter(isPurchaseMatchCandidate)
    .map((line) => ({
      line,
      purchaseDate: linePurchaseDateIso(line),
    }))
    .sort((a, b) => a.purchaseDate.localeCompare(b.purchaseDate));

  const notas = lines
    .filter(isNotaDeCreditoLine)
    .map((line) => ({
      line,
      notaDate: linePurchaseDateIso(line),
      absAmount: Math.abs(line.amount_clp),
    }))
    .sort((a, b) => a.notaDate.localeCompare(b.notaDate));

  for (const { line: nota, notaDate, absAmount } of notas) {
    if (absAmount < NOTA_DE_CREDITO_MATCH_MIN_CLP) {
      unmatchedNotaIds.add(nota.statement_line_id);
      continue;
    }

    let bestPurchase: FlowCcExpenseLineRowDraft | null = null;
    let bestPurchaseDate = "";

    for (const { line: purchase, purchaseDate } of purchases) {
      if (usedPurchaseIds.has(purchase.statement_line_id)) continue;
      if (purchase.account_id !== nota.account_id) continue;
      if (purchase.amount_clp !== absAmount) continue;
      // Same-day pairs: an instant reversal (charge + nota on one day) must annul its
      // twin, not reach back to an older innocent same-amount purchase.
      if (purchaseDate > notaDate) continue;
      if (purchaseDate > bestPurchaseDate) {
        bestPurchase = purchase;
        bestPurchaseDate = purchaseDate;
      }
    }

    if (bestPurchase == null) {
      // Large standalone credits without a matching purchase count as abonos (negative amount).
      continue;
    }

    usedPurchaseIds.add(bestPurchase.statement_line_id);
    annulledPurchaseIds.add(bestPurchase.statement_line_id);
    matchedNotaIds.add(nota.statement_line_id);
  }

  return { annulledPurchaseIds, matchedNotaIds, unmatchedNotaIds };
}

export function notaDeCreditoRoleForLine(
  line: FlowCcExpenseLineRowDraft,
  pairing: NotaDeCreditoPairingResult
): NotaDeCreditoRole | undefined {
  if (pairing.annulledPurchaseIds.has(line.statement_line_id)) return "annulled_purchase";
  if (pairing.matchedNotaIds.has(line.statement_line_id)) return "matched_nota";
  if (pairing.unmatchedNotaIds.has(line.statement_line_id)) return "unmatched_nota";
  return undefined;
}

export function enrichLinesWithNotaDeCreditoPairing(
  lines: readonly FlowCcExpenseLineRowDraft[]
): FlowCcExpenseLineRowDraft[] {
  const pairing = pairNotaDeCreditoAnnulments(lines);
  return lines.map((line) => {
    const role = notaDeCreditoRoleForLine(line, pairing);
    return role == null ? line : { ...line, nota_credito_role: role };
  });
}

/** Whether a positive CC line still counts toward gastos del mes after NOTA pairing. */
export function purchaseCountsAfterNotaPairing(line: FlowCcExpenseLineRowDraft): boolean {
  if (line.nota_credito_role === "annulled_purchase") return false;
  return countsTowardCcExpenseGastosMes(line.category_slug, {
    installment_flag: line.installment_flag,
    nro_cuota_current: line.nro_cuota_current,
  });
}
