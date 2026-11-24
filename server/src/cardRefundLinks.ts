/**
 * Card credits the user names as the refund of one purchase (`card_refund_links`, migration 365):
 * a partial refund («paid two, one came back»), the difference of an overcharge. The bank prints
 * such a credit with no reference to its purchase, so nothing pairs them on its own; the user picks
 * the purchase from the row's extras, among the candidates this module lists, and the expense
 * pipeline turns the link into the refund line's `refund_of` («Reembolso · <purchase>», the ⓘ card).
 * A credit with exactly one candidate under its own merchant carries that one as
 * `refund_suggestion`, for one confirm. Nothing is ever linked without the user.
 */
import { db } from "./db.js";
import { withRefundLinks } from "./expenseRefundLinks.js";
import type { FlowCcExpenseLineRow } from "./expenseLineTypes.js";
import { lineAmount } from "./lineMoney.js";
import { chileCalendarAddDays } from "./chileDate.js";

/** How far before a credit its purchase may be (a return or a price correction weeks later). */
export const REFUND_CANDIDATE_WINDOW_DAYS = 120;

/** At most this many candidates go to the picker, the merchant's own first, then the newest. */
const MAX_CANDIDATES = 30;

type Line = FlowCcExpenseLineRow;

function lineDay(l: Pick<Line, "purchase_on" | "occurred_on">): string {
  return l.purchase_on ?? l.occurred_on;
}

/** Letters and digits of a merchant, upper case: «GLASS LIDER.CL» → «GLASSLIDERCL». */
function merchantStem(l: Pick<Line, "merchant_key">): string {
  return (l.merchant_key ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
}

/**
 * Same merchant: one stem holds the other (the bank cuts names, and a store's section prefixes its
 * own: «GLASS LIDER.CL» is Lider's), at five letters at least.
 */
function sameMerchant(a: Line, b: Line): boolean {
  const x = merchantStem(a);
  const y = merchantStem(b);
  if (x.length < 5 || y.length < 5) return false;
  return x.includes(y) || y.includes(x);
}

/** A card credit the user can name a purchase for: a refund line of a card, with a flow. */
export function isLinkableCardRefund(
  l: Pick<Line, "source" | "card_refund" | "statement_line_id" | "flow_id"> & {
    amount?: Line["amount"];
    refund_of?: { manual?: true };
  }
): boolean {
  return (
    l.source === "cc" &&
    l.card_refund === true &&
    l.statement_line_id > 0 &&
    l.flow_id != null &&
    lineAmount(l).value < 0 &&
    (l.refund_of == null || l.refund_of.manual === true)
  );
}

export type RefundCandidate = { line: Line; merchant_match: boolean };

/**
 * The purchases a card credit may refund: the same card, a purchase (a one-shot or a plan's whole
 * price) in the credit's currency worth at least the credit, bought on or before the credit's day
 * and within {@link REFUND_CANDIDATE_WINDOW_DAYS} of it. The merchant's own first, then the newest.
 */
export function cardRefundCandidates(lines: readonly Line[], refund: Line): RefundCandidate[] {
  const money = lineAmount(refund);
  const refundDay = lineDay(refund);
  const from = chileCalendarAddDays(refundDay, -REFUND_CANDIDATE_WINDOW_DAYS);
  const seen = new Set<number>();
  const out: RefundCandidate[] = [];
  for (const l of lines) {
    if (l.source !== "cc" || l.account_id !== refund.account_id || l.flow_id == null || l.flow_id === refund.flow_id) continue;
    if (l.line_role !== "purchase" && l.line_role !== "installment_purchase_total") continue;
    if (l.card_refund === true || l.nota_credito_role === "annulled_purchase" || l.annulled != null) continue;
    const amount = lineAmount(l);
    if (amount.currency !== money.currency || amount.value < -money.value) continue;
    const day = lineDay(l);
    if (day > refundDay || day < from) continue;
    // A purchase broken into pieces is one candidate (its flow).
    if (seen.has(l.flow_id)) continue;
    seen.add(l.flow_id);
    out.push({ line: l, merchant_match: sameMerchant(l, refund) });
  }
  out.sort(
    (a, b) =>
      Number(b.merchant_match) - Number(a.merchant_match) ||
      lineDay(b.line).localeCompare(lineDay(a.line)) ||
      a.line.statement_line_id - b.line.statement_line_id
  );
  return out.slice(0, MAX_CANDIDATES);
}

/** The stored links: refund flow → purchase flow. */
export function loadCardRefundLinks(): Map<number, number> {
  const rows = db.prepare(`SELECT flow_id, purchase_flow_id FROM card_refund_links`).all() as {
    flow_id: number;
    purchase_flow_id: number;
  }[];
  return new Map(rows.map((r) => [r.flow_id, r.purchase_flow_id]));
}

/**
 * Pipeline step (after «flow ids» and «line money»): a linked credit reads as its purchase's refund
 * (`refund_of`, marked `manual`); an unlinked one with a single same-merchant candidate carries it as
 * `refund_suggestion`. A link whose purchase is not among the lines is bad state: it throws.
 */
export function withCardRefundLinks(lines: readonly Line[], links: Map<number, number> = loadCardRefundLinks()): Line[] {
  const refunds = lines.filter((l) => isLinkableCardRefund(l));
  if (refunds.length === 0) return [...lines];
  const byFlow = new Map<number, Line>();
  for (const l of lines) {
    if (l.source !== "cc" || l.flow_id == null || l.line_role === "installment_cuota") continue;
    const seen = byFlow.get(l.flow_id);
    // A purchase broken into pieces: the line the pieces leave of it stands for it.
    if (!seen || (seen.piece_seq != null && l.piece_seq == null)) byFlow.set(l.flow_id, l);
  }
  const linked = new Set<Line>();
  const suggestions = new Map<Line, Line>();
  const staged = lines.map((l) => {
    if (!refunds.includes(l) || l.refund_of != null) return l;
    const purchaseFlow = links.get(l.flow_id!);
    if (purchaseFlow != null) {
      const purchase = byFlow.get(purchaseFlow);
      if (!purchase) throw new Error(`card refund line ${l.statement_line_id} is linked to flow ${purchaseFlow}, which no expense line is`);
      const next = { ...l, refund_of_line_id: purchase.statement_line_id };
      linked.add(next);
      return next;
    }
    const sameMerchant = cardRefundCandidates(lines, l).filter((c) => c.merchant_match);
    if (sameMerchant.length === 1) suggestions.set(l, sameMerchant[0]!.line);
    return l;
  });
  const withLinks = linked.size > 0 ? withRefundLinks(staged) : staged;
  return withLinks.map((l, i) => {
    if (linked.has(staged[i]!)) return { ...l, refund_of: { ...l.refund_of!, manual: true as const } };
    const purchase = suggestions.get(staged[i]!);
    if (!purchase) return l;
    return {
      ...l,
      refund_suggestion: {
        line_id: purchase.statement_line_id,
        purchase_date: lineDay(purchase),
        amount: lineAmount(purchase),
        merchant: purchase.merchant,
        ...(purchase.display_merchant != null ? { display_merchant: purchase.display_merchant } : {}),
        ...(purchase.payment_name != null ? { payment_name: purchase.payment_name } : {}),
      },
    };
  });
}
