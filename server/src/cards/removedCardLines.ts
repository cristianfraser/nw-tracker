/**
 * The card lines a statement import removes without handing their identity to another row (no
 * restate, carry or fold): a re-imported line with no pair, a bucket line the statement does not
 * carry and that cannot be annulled, a line two plans could take. Each is described before it goes
 * — its facts and what the user had filed on it — and carried in every statement import's result;
 * when one carried something the user filed, one notification says so, so an unattended nightly
 * import cannot lose it unnoticed.
 */
import type { CardLineFiledAssignment, CardLineRemovedWithoutPair } from "nw-tracker-contracts";
import { db } from "../db.js";
import { insertAppMessage } from "../appMessages.js";
import { statementLineDateIso } from "../ccInstallmentPayBy.js";
import { cardLineFlowIds } from "../flows/cardLineAdoption.js";
import { isAutoAdditionalCardPurchaseNote } from "../ccAdditionalCardNoteText.js";
import { ADDITIONAL_CARD_CC_EXPENSE_SLUG } from "../ccExpenseCategories.js";

const selLine = db.prepare(
  `SELECT l.id, l.merchant, l.transaction_date, l.posting_date, l.amount, l.currency FROM cc_statement_lines l WHERE l.id = ?`
);
const has = (sql: string) => {
  const st = db.prepare(sql);
  return (...args: number[]): boolean => st.get(...args) != null;
};
const selCategories = db.prepare(
  `SELECT c.slug FROM flow_categories f LEFT JOIN cc_expense_categories c ON c.id = f.category_id WHERE f.flow_id = ?`
);
const hasLineCategory = has(`SELECT 1 FROM cc_expense_line_categories WHERE statement_line_id = ? LIMIT 1`);
const selNotes = db.prepare(`SELECT notes FROM flow_notes WHERE flow_id = ?`);
const hasBigGroup = has(`SELECT 1 FROM flow_big_groups WHERE flow_id = ? LIMIT 1`);
const hasPieces = has(`SELECT 1 FROM flow_parts WHERE flow_id = ? LIMIT 1`);
const hasLinks = has(
  `SELECT 1 FROM flow_links WHERE flow_id = ?
   UNION ALL SELECT 1 FROM card_refund_links WHERE flow_id = ? OR purchase_flow_id = ? LIMIT 1`
);
const flowHasLinks = (flowId: number): boolean => hasLinks(flowId, flowId, flowId);

/**
 * The part of a purchase note the user wrote: an additional cardholder's machine line
 * (`auto:additional-card|…`, `ccAdditionalCardNoteText.ts`) is the importer's, the text after it the
 * user's.
 */
function userNoteText(note: string): string {
  const t = String(note ?? "").trim();
  if (!isAutoAdditionalCardPurchaseNote(t)) return t;
  return t.split("\n").slice(1).join("\n").trim();
}

/**
 * What the user filed on a card line: on the flow its key's rows answer to, its own flow, its
 * per-line category. What the importers write and mark is left out: the additional cardholder's
 * automatic «Único» (`additional_card`, written with its `auto:additional-card|…` note line) and
 * that note line. What carries no mark is counted: a per-line category override (the user's, or one
 * a vendor-catalog change kept), a category or big group copied from a kept twin.
 */
export function cardLineFiledAssignments(lineId: number): CardLineFiledAssignment[] {
  const { keyed, own } = cardLineFlowIds(lineId);
  const filed: CardLineFiledAssignment[] = [];
  const notes = keyed != null ? (selNotes.all(keyed) as { notes: string }[]).map((n) => n.notes) : [];
  const autoAdditionalCard = notes.some((n) => isAutoAdditionalCardPurchaseNote(String(n).trim()));
  const categories = keyed != null ? (selCategories.all(keyed) as { slug: string | null }[]) : [];
  const userCategory = categories.some((c) => !(autoAdditionalCard && c.slug === ADDITIONAL_CARD_CC_EXPENSE_SLUG));
  if (userCategory || hasLineCategory(lineId)) filed.push("category");
  if (notes.some((n) => userNoteText(n) !== "")) filed.push("note");
  if (keyed != null && hasBigGroup(keyed)) filed.push("big_group");
  if (own != null && hasPieces(own)) filed.push("pieces");
  if ((own != null && flowHasLinks(own)) || (keyed != null && keyed !== own && flowHasLinks(keyed))) filed.push("links");
  return filed;
}

/** A line about to be removed without a pair, described while it is still on file. */
export function describeRemovedCardLine(
  lineId: number,
  reason: CardLineRemovedWithoutPair["reason"],
  ambiguity: CardLineRemovedWithoutPair["ambiguity"]
): CardLineRemovedWithoutPair {
  const l = selLine.get(lineId) as
    | { id: number; merchant: string | null; transaction_date: string | null; posting_date: string | null; amount: number; currency: string }
    | undefined;
  if (!l) throw new Error(`removed card line ${lineId}: not on file`);
  return {
    line_id: l.id,
    merchant: l.merchant,
    date: statementLineDateIso(l),
    amount: l.amount,
    currency: l.currency,
    reason,
    ambiguity,
    filed: cardLineFiledAssignments(lineId),
  };
}

/** One report line per removed line, as the importers print them. */
export function removedCardLineReport(r: CardLineRemovedWithoutPair): string {
  return (
    `removed without a pair: line ${r.line_id} «${r.merchant ?? "?"}» ${r.date ?? "?"} ${r.amount} ${r.currency} — ${r.reason}` +
    (r.ambiguity ? ` (${r.ambiguity.replace(/_/g, " ")})` : "") +
    (r.filed.length > 0 ? `; lost what was filed: ${r.filed.join(", ")}` : "; nothing filed on it")
  );
}

export const REMOVED_WITH_FILED_TITLE = "Card lines removed with what was filed on them";

/**
 * One notification for the lines of one import that carried something the user filed; none when
 * no removed line carried anything.
 */
export function notifyRemovedCardLinesWithFiled(accountId: number, removed: readonly CardLineRemovedWithoutPair[]): void {
  const filed = removed.filter((r) => r.filed.length > 0);
  if (filed.length === 0) return;
  const lines = filed.map(
    (r) =>
      `«${r.merchant ?? "?"}» of ${r.date ?? "?"} (${r.amount} ${r.currency}): ${r.filed.join(", ")} — ${r.reason}` +
      (r.ambiguity ? ` (${r.ambiguity.replace(/_/g, " ")})` : "")
  );
  insertAppMessage(
    "notification",
    REMOVED_WITH_FILED_TITLE,
    `A statement import on card account ${accountId} removed ${filed.length} line(s) no other row could take over, ` +
      `and with them what was filed on them:\n${lines.join("\n")}`
  );
}
