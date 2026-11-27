/**
 * The writers of annulled card purchases (`ccAnnulledPurchases.ts` owns the table and the readers):
 * the feed mirror and the cupo gap record a dropped bucket line instead of deleting it, a listing
 * that shows the purchase again undoes the annulment, and a statement settles them — billing the
 * purchase after all, or refunding it with a real credit. Kept apart from the table module because
 * it reaches into the feed matchers and the owed figures the readers' modules must not import.
 *
 * Every function here runs inside the caller's card-line write (the feed import's or the
 * statement's) and returns a report; none of them swallows a mismatch.
 */
import { daysBetweenIso } from "nw-tracker-contracts";
import { db } from "./db.js";
import { chileWallClockAt } from "./chileDate.js";
import type { CardLinePlan } from "./cards/lineWriteSession.js";
import { merchantsMatchForCrossDedupe } from "./cards/purchases.js";
import {
  bucketLineMatchesFeedLine,
  bucketLinePurchaseIso,
  listingLineAmount,
  listingLineCurrency,
  listOpenBucketLines,
  merchantsSame,
  type CcOpenBucketLine,
  type ListingCurrency,
} from "./ccFeedCuotaPurchases.js";
import { currencyMinorDigits } from "./displayUnits.js";
import { sameCoin } from "./matching/money.js";
import {
  mirrorRemovedRow,
  type CcFeedMirrorAnnulled,
} from "./ccFeedMirror.js";
import {
  annulOpenBucketLines,
  deleteAnnulledPurchase,
  listAnnulledPurchases,
  type CcAnnulledPurchase,
} from "./ccAnnulledPurchases.js";
import type { CcListingLine } from "./ccWebPasteParse.js";
import { pairOneToOne } from "./matching/pairing.js";
import { resolveCcExpensePurchaseKey } from "./ccExpenseCategories.js";
import { adoptFlow, flowExists } from "./flows/flowAdoption.js";
import { ensureFlowForKey, flowIdForKey } from "./flows/flowIdentity.js";
import { compareArrival, flowArrival, setFlowArrival } from "./flows/flowFirstSeen.js";
import { listPlansForLineMatching, planMatchesOneShotLine, type CardPlanForMatching } from "./cards/purchases.js";
import { planExpenseKey } from "./ccCrossImportDedupe.js";
import { isHomeCurrency } from "./displayUnits.js";
import { MATCH_WINDOWS } from "./matching/windows.js";

export type Currency = ListingCurrency;

/** The amount of a card line in its own currency's coin (integer pesos, integer cents); `ccAnnulmentCupoGap.ts` reads it. */
export function coin(amount: number, currency: Currency): number {
  return Math.round(amount * 10 ** currencyMinorDigits(currency));
}

// ── annulling what a feed no longer lists ─────────────────────────────────────────────────────────

/**
 * Record bucket lines as annulled purchases and return the plan that deletes them. `fetchedOnIso` is
 * the Chile day the listing was fetched; a line dated after it (a forward-dated pending
 * authorization) is annulled on its own day, so a row never annuls before its purchase.
 */
export function annulUnlistedLines(
  accountId: number,
  lines: readonly CcOpenBucketLine[],
  opts: { fetchedOnIso: string; basis: "feed_drop" | "cupo_gap"; evidence: string | null }
): { plan: CardLinePlan; annulled: CcFeedMirrorAnnulled[] } {
  const annulled: CcFeedMirrorAnnulled[] = [];
  for (const line of lines) {
    const purchaseIso = bucketLinePurchaseIso(line);
    if (!purchaseIso) throw new Error(`annulUnlistedLines: line ${line.id} has no readable date`);
    const res = annulOpenBucketLines(accountId, [line.id], {
      annulledOn: opts.fetchedOnIso < purchaseIso ? purchaseIso : opts.fetchedOnIso,
      basis: opts.basis,
      evidence: opts.evidence,
    });
    annulled.push({ ...mirrorRemovedRow(line), annulled_purchase_id: res.annulled[0]!.id, basis: opts.basis });
  }
  return { plan: { deleteLineIds: lines.map((l) => l.id), carry: [] }, annulled };
}

/** The Chile day an observation (an ISO instant) falls on. */
export function chileDayOf(isoInstant: string): string {
  return chileWallClockAt(new Date(isoInstant)).ymd;
}

// ── a listing that shows an annulled purchase again ───────────────────────────────────────────────

export type CcRelistedAnnulment = {
  annulled_purchase_id: number;
  merchant: string;
  amount: number;
  currency: string;
  purchase_date: string;
  /**
   * What stands for the purchase now: `line` — the bucket line the listing wrote for it; `plan` —
   * the cuota plan the listing row was skipped for; `statement_line` — the statement line it was
   * skipped as a duplicate of. Each took the annulment's flow and the annulment went. `left_standing`
   * — no single row could be named (none, several, or a plan and the annulment's pieces): the
   * annulment stays, its flow with it, and `reason` says why.
   */
  outcome: "line" | "plan" | "statement_line" | "left_standing";
  /** The line or plan that took the flow (null when left standing). */
  row_id: number | null;
  reason: string | null;
};

/** An annulment a listing shows again, waiting for the lines the listing writes ({@link settleRelistedAnnulments}). */
export type CcRelistedAnnulmentPending = { annulment: CcAnnulledPurchase; feedLine: CcListingLine };

/**
 * The bank listed an annulled purchase again (it had voided it, then re-authorized the same
 * charge). Only listing rows no existing bucket line accounts for count (a twin purchase that is
 * still listed must not undo the annulment of its voided sibling), each annulment is matched by at
 * most one row, and the match is the importer's own: same currency and amount, a matching merchant,
 * the dates within `MATCH_WINDOWS.feed_mirror`. Writes nothing: call BEFORE the listing's lines are
 * inserted (it reads the bucket as it was), then {@link settleRelistedAnnulments} after.
 */
export function findRelistedAnnulments(accountId: number, feedLines: readonly CcListingLine[]): CcRelistedAnnulmentPending[] {
  const annulled = listAnnulledPurchases(accountId);
  if (annulled.length === 0 || feedLines.length === 0) return [];
  const window = MATCH_WINDOWS.feed_mirror.daysAfter;
  let free: readonly CcListingLine[] = feedLines;
  for (const maxDayGap of [0, window]) {
    free = pairOneToOne(listOpenBucketLines(accountId), free, {
      strategy: "first",
      accepts: (line, f) => bucketLineMatchesFeedLine(line, f, maxDayGap),
    }).unclaimed;
  }
  const pass = pairOneToOne(annulled, free, {
    strategy: "first",
    accepts: (a, f) =>
      a.currency === f.currency &&
      sameCoin(a.amount, Math.abs(f.amount), f.currency) &&
      Math.abs(daysBetweenIso(a.purchase_date, f.transaction_date)) <= window &&
      merchantsSame(a.merchant, f.merchant),
  });
  return pass.pairs.map(({ left, right }) => ({ annulment: left, feedLine: right }));
}

/** The card's newest line id: the lines a listing writes after it are newer (`settleRelistedAnnulments`). */
export function lastCardLineId(): number {
  return (db.prepare(`SELECT COALESCE(MAX(id), 0) AS id FROM cc_statement_lines`).get() as { id: number }).id;
}

type LineFacts = { id: number; transaction_date: string | null; posting_date: string | null; merchant: string | null; currency: string; amount: number | null; flow_id: number | null };

const selLinesOfKinds = (kinds: "listing" | "statement") =>
  db.prepare<[number, number]>(
    `SELECT l.id, l.transaction_date, l.posting_date, l.merchant, l.currency, l.amount, l.flow_id
     FROM cc_statement_lines l JOIN cc_statements s ON s.id = l.statement_id
     WHERE s.account_id = ? AND l.id > ? AND l.installment_flag = 0
       AND s.source_kind ${kinds === "listing" ? "IN" : "NOT IN"} ('listing_open', 'listing_other')
     ORDER BY l.id`
  );
const selWrittenListingLines = selLinesOfKinds("listing");
const selStatementLines = selLinesOfKinds("statement");
const selFlowHasParts = db.prepare(`SELECT 1 FROM flow_parts WHERE flow_id = ? LIMIT 1`);

/**
 * After the listing's lines are written, each re-listed purchase is handed to the row that now
 * stands for it, which takes the annulment's flow (the purchase the app first saw: its arrival,
 * category, note, big group), and only then does the annulment go:
 *  - the new listing line (id above `lastLineIdBefore`) written from its listing row — same
 *    currency, amount, merchant and day; one line per annulment and one annulment per line
 *    (`mutual_unique`) — takes it, the line's own flow folding in, the line's key answering for it;
 *  - else, when the row was skipped as a cuota plan's purchase, the one plan it matches (a peso
 *    one-shot of the plan's day, its principal or one cuota, `planMatchesOneShotLine`) takes it,
 *    folded into the flow the plan's lines read (its `installment-h:` key) — never an annulment
 *    carrying pieces, which a plan takes none of;
 *  - else, when it was skipped as a duplicate of a statement line, the one statement line of the
 *    listing row's figures (`bucketLineMatchesFeedLine`, the feed-mirror window) takes it.
 * The earlier arrival's assignments win in a fold onto a row on file (ties: the row's). An
 * annulment no single row stands for is left standing with its flow and reported. An annulment
 * whose flow is gone (recorded before migration 380 held it) has no arrival to hand over: the new
 * line it stands for is a purchase on file before, so the stamp this listing wrote on it (order above
 * `stampsSinceSeq`) goes, and it reads as older than any stamp, never as newly arrived.
 */
export function settleRelistedAnnulments(
  accountId: number,
  pending: readonly CcRelistedAnnulmentPending[],
  lastLineIdBefore: number,
  stampsSinceSeq: number
): CcRelistedAnnulment[] {
  if (pending.length === 0) return [];
  const window = MATCH_WINDOWS.feed_mirror.daysAfter;
  const written = selWrittenListingLines.all(accountId, lastLineIdBefore) as LineFacts[];
  const pass = pairOneToOne(pending, written, {
    strategy: "mutual_unique",
    accepts: (p, line) => bucketLineMatchesFeedLine(line, p.feedLine, 0),
  });
  const lineOf = new Map(pass.pairs.map((pr) => [pr.left, pr.right]));
  const claimed = new Set(pass.pairs.map((p) => p.right.id));
  const ambiguous = new Set(pass.ambiguous.map((x) => x.left));
  let plans: CardPlanForMatching[] | null = null;
  let statementLines: LineFacts[] | null = null;
  return pending.map((p) => {
    const a = p.annulment;
    const report = (outcome: CcRelistedAnnulment["outcome"], rowId: number | null, reason: string | null): CcRelistedAnnulment => {
      if (outcome !== "left_standing") deleteAnnulledPurchase(a.id);
      return { annulled_purchase_id: a.id, merchant: a.merchant, amount: a.amount, currency: a.currency, purchase_date: a.purchase_date, outcome, row_id: rowId, reason };
    };
    if (ambiguous.has(p)) return report("left_standing", null, "several new lines fit it, or it and another re-listed purchase fit one line");
    const line = lineOf.get(p);
    if (line) {
      if (line.flow_id == null) throw new Error(`relisted annulment ${a.id}: line ${line.id} has no flow`);
      if (flowExists(a.flow_id) && a.flow_id !== line.flow_id) {
        adoptFlow({ survivor: a.flow_id, arriving: line.flow_id }, { prefer: "survivor", key: resolveCcExpensePurchaseKey(line.id), previousKey: a.purchase_key });
      } else if (!flowExists(a.flow_id)) {
        const arrival = flowArrival(line.flow_id);
        if (arrival.kind === "stamped" && arrival.stamp.seq != null && arrival.stamp.seq > stampsSinceSeq) {
          setFlowArrival(line.flow_id, { kind: "before_stamps" });
        }
      }
      return report("line", line.id, null);
    }
    // The listing wrote no line for it: a row on file stood for the purchase already.
    const f = p.feedLine;
    if (isHomeCurrency(f.currency)) {
      plans ??= listPlansForLineMatching(accountId);
      const matching = plans.filter((plan) => planMatchesOneShotLine(plan, f.merchant, f.transaction_date, Math.abs(Math.trunc(f.amount))));
      if (matching.length > 1) return report("left_standing", null, `${matching.length} cuota plans match its listing row`);
      if (matching.length === 1) {
        const plan = matching[0]!;
        if (flowExists(a.flow_id)) {
          if (selFlowHasParts.get(a.flow_id) != null) return report("left_standing", null, `split into pieces, which cuota plan ${plan.id} cannot take`);
          const key = planExpenseKey(accountId, plan);
          if (key == null) return report("left_standing", null, `cuota plan ${plan.id} has no expense key`);
          const target = flowIdForKey(key) ?? ensureFlowForKey(key);
          if (target !== a.flow_id) {
            const prefer = compareArrival(flowArrival(a.flow_id), flowArrival(target)) < 0 ? "arriving" : "survivor";
            adoptFlow({ survivor: target, arriving: a.flow_id }, { prefer });
          }
        }
        return report("plan", plan.id, null);
      }
    }
    statementLines ??= selStatementLines.all(accountId, 0) as LineFacts[];
    const onStatement = statementLines.filter((l) => !claimed.has(l.id) && bucketLineMatchesFeedLine(l, f, window));
    if (onStatement.length > 1) return report("left_standing", null, `${onStatement.length} statement lines match its listing row`);
    if (onStatement.length === 1) {
      const sl = onStatement[0]!;
      if (sl.flow_id == null) throw new Error(`relisted annulment ${a.id}: statement line ${sl.id} has no flow`);
      claimed.add(sl.id);
      if (flowExists(a.flow_id) && a.flow_id !== sl.flow_id) {
        const prefer = compareArrival(flowArrival(a.flow_id), flowArrival(sl.flow_id)) < 0 ? "arriving" : "survivor";
        adoptFlow({ survivor: sl.flow_id, arriving: a.flow_id }, { prefer });
      }
      return report("statement_line", sl.id, null);
    }
    return report("left_standing", null, "the listing wrote no line for it and no plan or statement line stands for it");
  });
}

// ── the statement settles annulments ──────────────────────────────────────────────────────────────

const selTaggedKind = db.prepare(`SELECT cuota_purchase_kind FROM cc_statement_lines WHERE id = ?`);

/**
 * A bucket line of a listing that a statement does not bill may be ANNULLED (kept as purchase +
 * annulment) only when it is a plain positive one-shot charge: not a cuota line, not a line tagged
 * as a cuota purchase (the statement's plan supersedes it), not a credit or payment. Anything else
 * keeps the delete the reconcile always did.
 */
export function bucketLineAnnullable(line: { id: number; installment_flag: boolean | number; amount: number | null }): boolean {
  return bucketLineAnnullableGiven(line, bucketLineCuotaPurchaseKind(line.id));
}

/** A bucket line's cuota-purchase tag (`cc_statement_lines.cuota_purchase_kind`), else null. */
export function bucketLineCuotaPurchaseKind(lineId: number): string | null {
  return (selTaggedKind.get(lineId) as { cuota_purchase_kind: string | null } | undefined)?.cuota_purchase_kind ?? null;
}

/** {@link bucketLineAnnullable} with the line's cuota-purchase tag given (pure). */
export function bucketLineAnnullableGiven(
  line: { installment_flag: boolean | number; amount: number | null },
  cuotaPurchaseKind: string | null
): boolean {
  if (line.installment_flag) return false;
  const amount = listingLineAmount(line);
  if (amount == null || !(amount > 0)) return false;
  return cuotaPurchaseKind == null;
}

/** A statement line as the annulment matchers read it: its amount in its own currency. */
export type StatementChargeLike = {
  id: number;
  merchant: string | null;
  amount: number | null;
  currency: Currency;
  iso: string | null;
};

/**
 * A pending bucket line the statement settled differently: a line of the same currency within
 * `MATCH_WINDOWS.feed_mirror` days with a matching merchant and another amount (the authorization
 * settled for another figure), or the same amount under another name. Such a line is deleted, not
 * annulled — it was never voided.
 */
export function statementRestatesBucketLine(
  bucket: { id: number; merchant: string | null; currency: string; amount: number | null; iso: string },
  statementLines: readonly StatementChargeLike[]
): boolean {
  return statementLineRestatingBucketLine(bucket, statementLines) != null;
}

/** The first statement line that restates the bucket line ({@link statementRestatesBucketLine}), if any. */
export function statementLineRestatingBucketLine<S extends StatementChargeLike>(
  bucket: { id: number; merchant: string | null; currency: string; amount: number | null; iso: string },
  statementLines: readonly S[]
): S | undefined {
  const currency = listingLineCurrency(bucket);
  const amount = listingLineAmount(bucket) ?? 0;
  const window = MATCH_WINDOWS.feed_mirror.daysAfter;
  return statementLines.find((s) => {
    if (s.currency !== currency || s.iso == null) return false;
    if (Math.abs(daysBetweenIso(bucket.iso, s.iso)) > window) return false;
    const sAmount = s.amount;
    if (sAmount == null || !(sAmount > 0)) return false;
    return sameCoin(sAmount, amount, currency) ? true : merchantsMatchForCrossDedupe(bucket.merchant, s.merchant);
  });
}

/** An annulled purchase as the statement settlement reads it. */
export type AnnulmentForSettlement = Pick<CcAnnulledPurchase, "id" | "currency" | "amount" | "merchant" | "purchase_date" | "bank_credit" | "flow_id" | "purchase_key">;

/** What a statement does to one annulment ({@link planAnnulmentSettlements}). */
export type AnnulmentSettlementDecision<A extends AnnulmentForSettlement> =
  | { annulment: A; outcome: "billed"; statement_line_id: number }
  | { annulment: A; outcome: "bank_credit"; statement_line_id: number; credit_iso: string };

/**
 * A closed statement against the card's annulled purchases (pure; the statement import applies it,
 * `cards/statementLinePlanApply.ts`):
 *  - it bills the purchase after all (a charge of the same currency and amount, a matching
 *    merchant, within `MATCH_WINDOWS.feed_mirror` days of the purchase day) → the annulment goes
 *    and the billed line takes its flow, so the user's category, note and big group follow;
 *  - it carries a real credit for it (a nota de crédito: a credit of the same currency and amount,
 *    a matching merchant, dated on/after the purchase and within 180 days) → the bank refunded with
 *    a real line, so the annulment is kept as the PURCHASE and its synthetic refund is dropped
 *    (`bank_credit`, `annulled_on` = the credit's day): purchase + one refund, never two refunds.
 * Each statement line settles at most one annulment and vice versa; `usedLineIds` (statement lines
 * a bucket line already matched) are never taken. `annulments` in the order the card lists them
 * (purchase day, then id); bank-credited ones are skipped.
 */
export function planAnnulmentSettlements<A extends AnnulmentForSettlement>(
  annulments: readonly A[],
  statementLines: readonly StatementChargeLike[],
  usedLineIds: ReadonlySet<number>
): AnnulmentSettlementDecision<A>[] {
  const open = annulments.filter((a) => !a.bank_credit);
  if (open.length === 0) return [];
  const window = MATCH_WINDOWS.feed_mirror.daysAfter;
  const free = statementLines.filter((s) => !usedLineIds.has(s.id) && s.iso != null);
  const taken = new Set<number>();
  const out: AnnulmentSettlementDecision<A>[] = [];
  const sameMoney = (a: A, s: StatementChargeLike, sign: 1 | -1): boolean => {
    if (s.currency !== a.currency) return false;
    const v = s.amount;
    return v != null && sign * v > 0 && sameCoin(Math.abs(v), a.amount, s.currency);
  };
  for (const a of open) {
    const billed = free.find(
      (s) =>
        !taken.has(s.id) &&
        sameMoney(a, s, 1) &&
        Math.abs(daysBetweenIso(a.purchase_date, s.iso!)) <= window &&
        merchantsMatchForCrossDedupe(a.merchant, s.merchant)
    );
    if (billed) {
      taken.add(billed.id);
      out.push({ annulment: a, outcome: "billed", statement_line_id: billed.id });
      continue;
    }
    const credit = free.find(
      (s) =>
        !taken.has(s.id) &&
        sameMoney(a, s, -1) &&
        s.iso! >= a.purchase_date &&
        daysBetweenIso(a.purchase_date, s.iso!) <= 180 &&
        merchantsMatchForCrossDedupe(a.merchant, s.merchant)
    );
    if (credit) {
      taken.add(credit.id);
      out.push({ annulment: a, outcome: "bank_credit", statement_line_id: credit.id, credit_iso: credit.iso! });
    }
  }
  return out;
}
