/**
 * Card credits the user names as the refund of one purchase (`card_refund_links`, migration 365):
 * a partial refund («paid two, one came back»), the difference of an overcharge. The bank prints
 * such a credit with no reference to its purchase, so nothing pairs them on its own; the user picks
 * the purchase from the row's extras, among the candidates this module lists, and the expense
 * pipeline turns the link into the refund line's `refund_of` («Reembolso · <purchase>», the ⓘ card).
 * A credit with exactly one candidate under its own merchant carries that one as
 * `refund_suggestion`, for one confirm. Nothing is ever linked without the user.
 *
 * A link names flows, and both ends hold their flow (migration 366), so a re-import that rewrites
 * a line row keeps it. A purchase a cuota plan later took over (the line stays on file, superseded:
 * `oneShotLinesSupersededByPlans`) is read as that plan's whole price. A link whose purchase no line
 * stands for any more is shown on the refund as broken (`refund_link_broken`), for the user to undo.
 */
import { db } from "./db.js";
import { findLines, oneShotLinesSupersededByPlans } from "./cards/purchases.js";
import { withRefundLinks } from "./expenseRefundLinks.js";
import type { FlowCcExpenseLineRow } from "./expenseLineTypes.js";
import { lineAmount } from "./lineMoney.js";
import { chileCalendarAddDays } from "./chileDate.js";

/** How far before a credit its purchase may be (a return or a price correction weeks later). */
export const REFUND_CANDIDATE_WINDOW_DAYS = 120;

/** At most this many candidates go to the picker, the merchant's own first, then the newest. */
const MAX_CANDIDATES = 30;

type Line = FlowCcExpenseLineRow;
type Money = NonNullable<Line["amount"]>;

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

/**
 * One purchase as the picker offers it: its flow, the line that stands for it (the whole line, or
 * the one its pieces leave), every line of it and its whole amount.
 */
export type RefundPurchase = { flow_id: number; line: Line; lines: Line[]; amount: Money; day: string };

export type RefundCandidate = RefundPurchase & { merchant_match: boolean };

/** The card purchases a credit may be the refund of, by card: built once per pipeline run. */
export type RefundPurchaseIndex = Map<number, RefundPurchase[]>;

/** Every card purchase (a one-shot or a plan's whole price) by card, one entry per flow. */
export function refundPurchaseIndex(lines: readonly Line[]): RefundPurchaseIndex {
  const byFlow = new Map<number, Line[]>();
  for (const l of lines) {
    if (l.source !== "cc" || l.flow_id == null) continue;
    if (l.line_role !== "purchase" && l.line_role !== "installment_purchase_total") continue;
    if (l.card_refund === true || l.nota_credito_role === "annulled_purchase" || l.annulled != null) continue;
    const group = byFlow.get(l.flow_id);
    if (group) group.push(l);
    else byFlow.set(l.flow_id, [l]);
  }
  const index: RefundPurchaseIndex = new Map();
  for (const [flowId, group] of byFlow) {
    // A purchase broken into pieces is one candidate: its whole amount, under the line its pieces leave.
    const line = group.find((l) => l.piece_seq == null) ?? group[0]!;
    const currency = lineAmount(line).currency;
    if (group.some((l) => lineAmount(l).currency !== currency)) {
      throw new Error(`card purchase flow ${flowId} has lines in two currencies`);
    }
    const value = group.reduce((sum, l) => sum + lineAmount(l).value, 0);
    if (value <= 0) continue;
    const purchase: RefundPurchase = { flow_id: flowId, line, lines: group, amount: { value, currency }, day: lineDay(line) };
    const forCard = index.get(line.account_id);
    if (forCard) forCard.push(purchase);
    else index.set(line.account_id, [purchase]);
  }
  return index;
}

/**
 * The purchases a card credit may refund: the same card, a purchase in the credit's currency worth
 * at least the credit, bought on or before the credit's day and within
 * {@link REFUND_CANDIDATE_WINDOW_DAYS} of it. The merchant's own first, then the newest.
 */
export function cardRefundCandidates(index: RefundPurchaseIndex, refund: Line): RefundCandidate[] {
  const money = lineAmount(refund);
  const refundDay = lineDay(refund);
  const from = chileCalendarAddDays(refundDay, -REFUND_CANDIDATE_WINDOW_DAYS);
  const out: RefundCandidate[] = [];
  for (const p of index.get(refund.account_id) ?? []) {
    if (p.flow_id === refund.flow_id || p.amount.currency !== money.currency || p.amount.value < -money.value) continue;
    if (p.day > refundDay || p.day < from) continue;
    out.push({ ...p, merchant_match: sameMerchant(p.line, refund) });
  }
  out.sort(
    (a, b) =>
      Number(b.merchant_match) - Number(a.merchant_match) ||
      b.day.localeCompare(a.day) ||
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
 * The plan that took over a purchase flow no line carries (its one-shot line stays on file,
 * superseded), or null when nothing did.
 */
export type SupersedingPlan = (purchaseFlowId: number) => number | null;

export function supersedingPlanFromDb(): SupersedingPlan {
  const supersededByAccount = new Map<number, ReturnType<typeof oneShotLinesSupersededByPlans>>();
  return (purchaseFlowId) => {
    for (const line of findLines({ flowId: purchaseFlowId })) {
      let superseded = supersededByAccount.get(line.account_id);
      if (!superseded) {
        superseded = oneShotLinesSupersededByPlans(line.account_id);
        supersededByAccount.set(line.account_id, superseded);
      }
      const plan = superseded.get(line.line_id);
      if (plan) return plan.id;
    }
    return null;
  };
}

/**
 * Pipeline step (after «flow ids» and «line money»): a linked credit reads as its purchase's refund
 * (`refund_of`, marked `manual`); a link no line stands for marks the credit `refund_link_broken`;
 * an unlinked credit with a single same-merchant candidate carries it as `refund_suggestion`.
 */
export function withCardRefundLinks(
  lines: readonly Line[],
  links: Map<number, number> = loadCardRefundLinks(),
  supersedingPlan: SupersedingPlan = supersedingPlanFromDb()
): Line[] {
  const refunds = new Set(lines.filter((l) => isLinkableCardRefund(l)));
  if (refunds.size === 0) return [...lines];
  const byFlow = new Map<number, Line>();
  for (const l of lines) {
    if (l.source !== "cc" || l.flow_id == null || l.line_role === "installment_cuota") continue;
    const seen = byFlow.get(l.flow_id);
    // A purchase broken into pieces: the line the pieces leave of it stands for it.
    if (!seen || (seen.piece_seq != null && l.piece_seq == null)) byFlow.set(l.flow_id, l);
  }
  // A plan's whole price, by plan: what a superseded purchase reads as.
  const planTotals = new Map<number, Line>();
  for (const l of lines) {
    if (l.source === "cc" && l.line_role === "installment_purchase_total" && l.installment_purchase_id != null) {
      planTotals.set(l.installment_purchase_id, l);
    }
  }
  let index: RefundPurchaseIndex | null = null;
  const linked = new Set<Line>();
  const suggestions = new Map<Line, RefundCandidate>();
  const staged = lines.map((l) => {
    if (!refunds.has(l) || l.refund_of != null) return l;
    const purchaseFlow = links.get(l.flow_id!);
    if (purchaseFlow != null) {
      const plan = byFlow.has(purchaseFlow) ? null : supersedingPlan(purchaseFlow);
      const purchase = byFlow.get(purchaseFlow) ?? (plan != null ? planTotals.get(plan) : undefined);
      if (!purchase) return { ...l, refund_link_broken: true as const };
      const next = { ...l, refund_of_line_id: purchase.statement_line_id };
      linked.add(next);
      return next;
    }
    index ??= refundPurchaseIndex(lines);
    const sameMerchant = cardRefundCandidates(index, l).filter((c) => c.merchant_match);
    if (sameMerchant.length === 1) suggestions.set(l, sameMerchant[0]!);
    return l;
  });
  const withLinks = linked.size > 0 ? withRefundLinks(staged) : staged;
  return withLinks.map((l, i) => {
    if (linked.has(staged[i]!)) return { ...l, refund_of: { ...l.refund_of!, manual: true as const } };
    const suggested = suggestions.get(staged[i]!);
    if (!suggested) return l;
    const purchase = suggested.line;
    return {
      ...l,
      refund_suggestion: {
        line_id: purchase.statement_line_id,
        purchase_date: suggested.day,
        amount: suggested.amount,
        merchant: purchase.merchant,
        ...(purchase.display_merchant != null ? { display_merchant: purchase.display_merchant } : {}),
        ...(purchase.payment_name != null ? { payment_name: purchase.payment_name } : {}),
      },
    };
  });
}
