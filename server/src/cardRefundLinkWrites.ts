/**
 * The routes of the card refund links (`cardRefundLinks.ts`): the purchases a credit may refund,
 * and naming (or un-naming) one. Reads the cached expense lines, so it stays out of the pipeline's
 * import graph.
 */
import type { CardRefundCandidatesResponse } from "nw-tracker-contracts/dto/flows";
import { cardRefundCandidates, isLinkableCardRefund, refundPurchaseIndex, type RefundCandidate } from "./cardRefundLinks.js";
import { db } from "./db.js";
import { assignFlowExpenseLineCategory } from "./expenseAssignmentWrites.js";
import type { FlowCcExpenseLineRow } from "./expenseLineTypes.js";
import { cachedFlowsExpenseLines } from "./flowsMortgageCarrying.js";
import { InputError } from "./inputError.js";
import { toWireExpenseLine } from "./wireExpenseLine.js";

/** The card credit a request names: a refund line of that card the user can link. */
function refundLine(lines: readonly FlowCcExpenseLineRow[], accountId: number, lineId: number): FlowCcExpenseLineRow {
  const line = lines.find((l) => l.source === "cc" && l.account_id === accountId && l.statement_line_id === lineId);
  if (!line) throw new InputError(`card ${accountId} has no expense line ${lineId}`, 404);
  if (!isLinkableCardRefund(line)) throw new InputError(`line ${lineId} is not a card refund a purchase can be named for`);
  return line;
}

/**
 * A purchase's whole value in the unit: Σ its lines' (a purchase broken into pieces), null when a
 * line has none (its own currency is the unit) or the lines disagree on how they were converted.
 */
function wholeConverted(c: RefundCandidate, unit: string): CardRefundCandidatesResponse["candidates"][number]["converted"] {
  const parts = c.lines.map((l) => toWireExpenseLine(l, unit).converted);
  const first = parts[0];
  if (first == null || parts.some((p) => p == null || p.currency !== first.currency || p.rate_source !== first.rate_source)) {
    return null;
  }
  return { ...first, value: parts.reduce((sum, p) => sum + p!.value, 0) };
}

/** `GET /api/flows/expenses/refund-candidates?unit=&account_id=&line_id=`. */
export function cardRefundCandidatesResponse(accountId: number, lineId: number, unit: string): CardRefundCandidatesResponse {
  const lines = cachedFlowsExpenseLines();
  const refund = refundLine(lines, accountId, lineId);
  return {
    unit,
    candidates: cardRefundCandidates(refundPurchaseIndex(lines), refund).map((c) => ({
      line_id: c.line.statement_line_id,
      purchase_date: c.day,
      amount: c.amount,
      converted: wholeConverted(c, unit),
      name: toWireExpenseLine(c.line, unit).name,
      category_slug: c.line.category_slug,
      merchant_match: c.merchant_match,
    })),
  };
}

/**
 * `PUT /api/flows/expenses/refund-links`: the credit refunds that purchase (one of its candidates).
 * A credit still «sin categoría» takes the purchase's category as its own («Único»), so the refund
 * nets in the category it was spent in.
 */
export function linkCardRefund(opts: { accountId: number; lineId: number; purchaseLineId: number }): { ok: true } {
  const lines = cachedFlowsExpenseLines();
  const refund = refundLine(lines, opts.accountId, opts.lineId);
  const candidate = cardRefundCandidates(refundPurchaseIndex(lines), refund).find((c) => c.line.statement_line_id === opts.purchaseLineId);
  if (!candidate) {
    throw new InputError(`line ${opts.purchaseLineId} is not a purchase card ${opts.accountId}'s credit ${opts.lineId} can refund`);
  }
  const purchase = candidate.line;
  db.transaction(() => {
    db.prepare(
      `INSERT INTO card_refund_links (flow_id, purchase_flow_id) VALUES (?, ?)
       ON CONFLICT (flow_id) DO UPDATE SET purchase_flow_id = excluded.purchase_flow_id`
    ).run(refund.flow_id!, purchase.flow_id!);
    if (refund.category_slug === "unclassified" && purchase.category_slug !== "unclassified") {
      assignFlowExpenseLineCategory({ lineId: refund.statement_line_id, source: "cc", unique: true, categorySlug: purchase.category_slug });
    }
  })();
  return { ok: true };
}

/** `DELETE /api/flows/expenses/refund-links?account_id=&line_id=`: the credit names no purchase again. */
export function unlinkCardRefund(opts: { accountId: number; lineId: number }): void {
  const refund = refundLine(cachedFlowsExpenseLines(), opts.accountId, opts.lineId);
  const deleted = db.prepare(`DELETE FROM card_refund_links WHERE flow_id = ?`).run(refund.flow_id!).changes;
  if (deleted === 0) throw new InputError(`line ${opts.lineId} names no purchase`, 404);
}
