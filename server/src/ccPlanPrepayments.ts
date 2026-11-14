/**
 * A plan the bank paid off at once, from the card feed (migration 334, `cc_plan_prepayments`).
 *
 * Santander's unbilled feed lists «PREPAGO EN CUOTAS» for a plan's whole outstanding principal, as
 * a debit (the ingest decoder flags it `plan_prepayment`; a refund of the purchase arrives beside
 * it as a «NOTA DE CREDITO», flagged `credit_note`). The bank's cupo then holds the plan no more:
 * the principal is in the prepayment line, which bills in the open facturación. The app pairs the
 * prepayment with exactly ONE plan of the card — same merchant (stem rules), bought on or before
 * the prepayment day, no cuota billed yet, principal equal to the prepayment to the peso — and
 * records it (`ccPlanPrepaymentsRead.ts` has the model). Zero or several candidates throw before
 * anything is written: the feed document stays staged, never a guess.
 *
 * The refund credit pairs with the plan the same way (same merchant and amount, dated between the
 * purchase and the payoff, a refund credit still unpaired): it is the purchase's refund in gastos,
 * under the plan's category.
 */
import { db } from "./db.js";
import { ledgerPlanCuotas, planRows, type CardPlanRow } from "./cards/purchases.js";
import { noteCardLineEvidence, noteCardLineWritten, withCardLineSession } from "./cards/lineWriteSession.js";
import { bucketLineMatchesFeedLine, listOpenBucketLines, merchantsSame } from "./ccFeedCuotaPurchases.js";
import { planPrepaymentRows } from "./ccPlanPrepaymentsRead.js";
import type { CcListingLine } from "./ccWebPasteParse.js";

export type CcPlanPrepaymentPaired = {
  purchase_id: number;
  merchant: string | null;
  purchase_date: string;
  paid_on: string;
  amount_clp: number;
  /** The bucket line of the prepayment, when it is on file. */
  line_id: number | null;
  /** The refund credit paired with the plan, when the listing carries one. */
  credit_line_id: number | null;
};

type Match = { feed: CcListingLine; plan: CardPlanRow };

const pesos = (line: CcListingLine): number => Math.abs(Math.round(line.amount));

function describe(line: CcListingLine): string {
  return `«${line.merchant}» ${pesos(line)} on ${line.transaction_date}`;
}

/**
 * Each unpaired prepayment row of the listing → its plan. Throws (nothing written) when a row has
 * no candidate plan or several. A row an earlier import already paired (a prepaid plan of the same
 * merchant, amount and day) is skipped.
 */
export function matchPlanPrepayments(accountId: number, lines: readonly CcListingLine[]): Match[] {
  const prepayments = lines.filter((l) => l.plan_prepayment);
  if (prepayments.length === 0) return [];
  const paired = planPrepaymentRows(accountId);
  const plans = planRows([accountId]);
  const planById = new Map(plans.map((p) => [p.id, p]));
  const billedPlanIds = new Set(ledgerPlanCuotas(accountId).map((c) => c.purchase_id));
  const taken = new Set(paired.map((r) => r.purchase_id));
  const out: Match[] = [];
  for (const feed of prepayments) {
    if (feed.currency !== "clp" || feed.amount <= 0) { // convention-ok: Chilean cuota plans are pesos only
      throw new Error(`card feed: prepayment ${describe(feed)} must be a peso debit`);
    }
    const amount = pesos(feed);
    // Already recorded by an earlier listing of the same row.
    const already = paired.find(
      (r) => r.paid_on === feed.transaction_date && r.amount_clp === amount && merchantsSame(planById.get(r.purchase_id)?.merchant, feed.merchant)
    );
    if (already) continue;
    const candidates = plans.filter(
      (p) =>
        !taken.has(p.id) &&
        !billedPlanIds.has(p.id) &&
        String(p.purchase_date).slice(0, 10) <= feed.transaction_date &&
        Math.round(p.total_amount_clp) === amount &&
        merchantsSame(p.merchant, feed.merchant)
    );
    if (candidates.length !== 1) {
      const named = candidates.map((p) => `#${p.id} «${p.merchant}» ${String(p.purchase_date).slice(0, 10)}`).join(", ");
      throw new Error(
        `card feed: prepayment ${describe(feed)} on account ${accountId} matches ${candidates.length} plans ` +
          `(want exactly one unbilled plan of the same principal and merchant)${named ? `: ${named}` : ""}`
      );
    }
    taken.add(candidates[0]!.id);
    out.push({ feed, plan: candidates[0]! });
  }
  return out;
}

const insPrepayment = db.prepare(
  `INSERT INTO cc_plan_prepayments (purchase_id, account_id, paid_on, amount_clp, line_id) VALUES (?, ?, ?, ?, ?)`
);
const updLine = db.prepare(`UPDATE cc_plan_prepayments SET line_id = ? WHERE purchase_id = ?`);
const updCredit = db.prepare(`UPDATE cc_plan_prepayments SET credit_line_id = ? WHERE purchase_id = ?`);

/**
 * After the listing's lines are on file: record the matched prepayments, link every prepayment
 * row to its bucket line, and pair the listing's refund credits with the prepaid plans. Idempotent:
 * a repeat of the same listing changes nothing.
 */
export function recordPlanPrepayments(
  accountId: number,
  lines: readonly CcListingLine[],
  matches: readonly Match[]
): CcPlanPrepaymentPaired[] {
  const prepayments = lines.filter((l) => l.plan_prepayment);
  const credits = lines.filter((l) => l.credit_note);
  if (matches.length === 0 && prepayments.length === 0 && credits.length === 0) return [];
  return withCardLineSession(accountId, "plan prepayments", () => {
    let changed = false;
    const bucket = listOpenBucketLines(accountId);
    const registered = () => planPrepaymentRows(accountId);
    const lineFor = (feed: CcListingLine, taken: Set<number>, sign: 1 | -1) =>
      bucket.find(
        (b) =>
          !taken.has(b.id) &&
          !b.installment_flag &&
          Math.sign(b.amount_clp ?? 0) === sign &&
          bucketLineMatchesFeedLine(b, feed, 0)
      );
    const planById = new Map(planRows([accountId]).map((p) => [p.id, p]));
    const takenLines = new Set<number>();
    for (const r of registered()) {
      if (r.line_id != null) takenLines.add(r.line_id);
      if (r.credit_line_id != null) takenLines.add(r.credit_line_id);
    }

    for (const { feed, plan } of matches) {
      const hit = lineFor(feed, takenLines, 1);
      insPrepayment.run(plan.id, accountId, feed.transaction_date, pesos(feed), hit?.id ?? null);
      if (hit) takenLines.add(hit.id);
      // The plan leaves every anchor's remainder from its purchase day on.
      noteCardLineEvidence(accountId, String(plan.purchase_date).slice(0, 10));
      changed = true;
    }
    // A prepayment already recorded whose line is not linked (the line was re-listed).
    for (const r of registered()) {
      if (r.line_id != null) continue;
      const plan = planById.get(r.purchase_id);
      const feed = prepayments.find(
        (f) => f.transaction_date === r.paid_on && pesos(f) === r.amount_clp && merchantsSame(plan?.merchant, f.merchant)
      );
      const hit = feed ? lineFor(feed, takenLines, 1) : undefined;
      if (hit) {
        updLine.run(hit.id, r.purchase_id);
        takenLines.add(hit.id);
        changed = true;
      }
    }
    // Refund credits: one per prepaid plan, the purchase's refund.
    for (const feed of credits) {
      if (feed.currency !== "clp" || feed.amount >= 0) continue; // convention-ok: Chilean cuota plans are pesos only
      const hit = lineFor(feed, takenLines, -1);
      if (!hit) continue;
      const open = registered().filter((r) => {
        const plan = planById.get(r.purchase_id);
        return (
          r.credit_line_id == null &&
          r.amount_clp === pesos(feed) &&
          plan != null &&
          String(plan.purchase_date).slice(0, 10) <= feed.transaction_date &&
          feed.transaction_date <= r.paid_on &&
          merchantsSame(plan.merchant, feed.merchant)
        );
      });
      if (open.length > 1) {
        throw new Error(
          `card feed: refund credit ${describe(feed)} on account ${accountId} fits ${open.length} prepaid plans ` +
            `(${open.map((r) => `#${r.purchase_id}`).join(", ")})`
        );
      }
      if (open.length === 1) {
        updCredit.run(hit.id, open[0]!.purchase_id);
        takenLines.add(hit.id);
        changed = true;
      }
    }
    if (changed) noteCardLineWritten(accountId);
    const planOf = (id: number) => planById.get(id);
    return registered().map((r) => ({
      purchase_id: r.purchase_id,
      merchant: planOf(r.purchase_id)?.merchant ?? null,
      purchase_date: String(planOf(r.purchase_id)?.purchase_date ?? "").slice(0, 10),
      paid_on: r.paid_on,
      amount_clp: r.amount_clp,
      line_id: r.line_id,
      credit_line_id: r.credit_line_id,
    }));
  });
}

/**
 * A statement settled bucket lines (`reconcileOpenWebPasteAfterPdfClose`): the prepayment and the
 * credit follow their line onto the statement line that bills it, before the bucket line is
 * deleted.
 */
export function carryPlanPrepaymentLines(accountId: number, settled: readonly { fromLineId: number; toLineId: number }[]): void {
  if (settled.length === 0) return;
  const toLine = new Map(settled.map((s) => [s.fromLineId, s.toLineId]));
  for (const r of planPrepaymentRows(accountId)) {
    const line = r.line_id != null ? toLine.get(r.line_id) : undefined;
    const credit = r.credit_line_id != null ? toLine.get(r.credit_line_id) : undefined;
    if (line != null) db.prepare(`UPDATE cc_plan_prepayments SET line_id = ? WHERE purchase_id = ?`).run(line, r.purchase_id);
    if (credit != null) db.prepare(`UPDATE cc_plan_prepayments SET credit_line_id = ? WHERE purchase_id = ?`).run(credit, r.purchase_id);
  }
}
