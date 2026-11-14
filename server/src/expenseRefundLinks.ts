/**
 * Last step of the expense lines for refunds whose purchase structured state names (`refund_of_line_id`,
 * set by the plan-prepayment credit step, the annulment drafts and the nota pairing): the refund
 * carries the purchase as its line finally reads — names, link label, receipt — so every list shows
 * «Reembolso · <purchase>» and its ⓘ card the purchase's own details. A leaf of `flowsExpenses.ts`.
 */
import type { ExpenseLinePaymentName, ExpenseLinkLabel, PaymentReceipt as PaymentReceiptDto } from "nw-tracker-contracts/dto/flows";

/** The fields the step reads and writes (structural, so this stays a leaf of `flowsExpenses.ts`). */
type RefundLinkLine = {
  source: string;
  account_id: number;
  statement_line_id: number;
  line_role: string;
  piece_seq?: number;
  purchase_key: string;
  purchase_on: string | null;
  occurred_on: string;
  merchant: string | null;
  display_merchant?: string;
  payment_name?: ExpenseLinePaymentName;
  link_label?: ExpenseLinkLabel;
  payment_receipt?: PaymentReceiptDto;
  refund_of_line_id?: number;
  refund_of?: {
    line_id: number;
    purchase_key: string;
    purchase_date: string;
    merchant: string | null;
    display_merchant?: string;
    payment_name?: ExpenseLinePaymentName;
    link_label?: ExpenseLinkLabel;
    payment_receipt?: PaymentReceiptDto;
  };
};

export function withRefundLinks<L extends RefundLinkLine>(lines: readonly L[]): L[] {
  if (!lines.some((l) => l.refund_of_line_id != null)) return [...lines];
  const purchases = new Map<string, L>();
  for (const l of lines) {
    if (l.source !== "cc" || l.refund_of_line_id != null || l.line_role === "installment_cuota") continue;
    const key = `${l.account_id}|${l.statement_line_id}`;
    const seen = purchases.get(key);
    // A purchase broken into pieces: the line the pieces leave of it (no piece) stands for it.
    if (!seen || (seen.piece_seq != null && l.piece_seq == null)) purchases.set(key, l);
  }
  return lines.map((l) => {
    if (l.refund_of_line_id == null) return l;
    const { refund_of_line_id: purchaseLineId, ...rest } = l;
    const purchase = purchases.get(`${l.account_id}|${purchaseLineId}`);
    if (!purchase) throw new Error(`refund line ${l.statement_line_id} refunds line ${purchaseLineId}, which is not among the expense lines`);
    return {
      ...rest,
      refund_of: {
        line_id: purchase.statement_line_id,
        purchase_key: purchase.purchase_key,
        purchase_date: purchase.purchase_on ?? purchase.occurred_on,
        merchant: purchase.merchant,
        ...(purchase.display_merchant != null ? { display_merchant: purchase.display_merchant } : {}),
        ...(purchase.payment_name != null ? { payment_name: purchase.payment_name } : {}),
        ...(purchase.link_label != null ? { link_label: purchase.link_label } : {}),
        ...(purchase.payment_receipt != null ? { payment_receipt: purchase.payment_receipt } : {}),
      },
    } as unknown as L;
  });
}
