import { isNotaDeCreditoMerchant, NOTA_DE_CREDITO_MATCH_MIN_CLP } from "./cards/notaDeCredito.js";
import type { ExpenseLineNotaPaired, FlowCcExpenseLineRowDraft, NotaDeCreditoRole } from "./expenseLineTypes.js";

export type { NotaDeCreditoRole };


export type NotaDeCreditoPairingResult = {
  annulledPurchaseIds: Set<number>;
  matchedNotaIds: Set<number>;
  unmatchedNotaIds: Set<number>;
  /** Each matched nota's line → the line of the purchase it was paired with. */
  purchaseLineByNotaId: Map<number, number>;
};


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
  const purchaseLineByNotaId = new Map<number, number>();

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
    purchaseLineByNotaId.set(nota.statement_line_id, bestPurchase.statement_line_id);
  }

  return { annulledPurchaseIds, matchedNotaIds, unmatchedNotaIds, purchaseLineByNotaId };
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
): ExpenseLineNotaPaired[] {
  const pairing = pairNotaDeCreditoAnnulments(lines);
  return lines.map((line) => {
    const role = notaDeCreditoRoleForLine(line, pairing);
    if (role == null) return line;
    const purchaseLine = role === "matched_nota" ? pairing.purchaseLineByNotaId.get(line.statement_line_id) : undefined;
    return { ...line, nota_credito_role: role, ...(purchaseLine == null ? {} : { refund_of_line_id: purchaseLine }) };
  });
}
