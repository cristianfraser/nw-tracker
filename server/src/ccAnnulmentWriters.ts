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
import { adoptFlow, flowExists, rowFlowId } from "./flows/flowAdoption.js";
import { resolveCcExpensePurchaseKey } from "./ccExpenseCategories.js";
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
  markAnnulledPurchaseBankCredited,
  type CcAnnulledPurchase,
} from "./ccAnnulledPurchases.js";
import type { CcListingLine } from "./ccWebPasteParse.js";
import { pairOneToOne } from "./matching/pairing.js";
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

export type CcRelistedAnnulment = { annulled_purchase_id: number; merchant: string; amount: number; currency: string; purchase_date: string };

/**
 * The bank listed an annulled purchase again (it had voided it, then re-authorized the same
 * charge): the annulment goes, so the purchase is not counted twice — its listing row re-imports
 * as the bucket line. Only listing rows no existing bucket line accounts for count (a twin purchase
 * that is still listed must not undo the annulment of its voided sibling), each annulment is undone
 * by at most one row, and the match is the importer's own: same currency and amount, a matching
 * merchant, the dates within `MATCH_WINDOWS.feed_mirror`. Call BEFORE the listing's lines are
 * inserted.
 */
export function removeRelistedAnnulments(accountId: number, feedLines: readonly CcListingLine[]): CcRelistedAnnulment[] {
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
  const out: CcRelistedAnnulment[] = [];
  for (const { left: a } of pass.pairs) {
    deleteAnnulledPurchase(a.id);
    out.push({ annulled_purchase_id: a.id, merchant: a.merchant, amount: a.amount, currency: a.currency, purchase_date: a.purchase_date });
  }
  return out;
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

export type CcAnnulmentSettled = {
  annulled_purchase_id: number;
  outcome: "billed" | "bank_credit";
  statement_line_id: number;
  /** `billed`: the annulment's flow (category, note, …) folded into the statement line's flow. */
  folded: boolean;
};

/**
 * A closed statement against the card's annulled purchases:
 *  - it bills the purchase after all (a charge of the same currency and amount, a matching
 *    merchant, within `MATCH_WINDOWS.feed_mirror` days of the purchase day) → the annulment is
 *    deleted and its flow folds into the statement line's, so the user's category, note and big
 *    group follow the purchase onto the billed line;
 *  - it carries a real credit for it (a nota de crédito: a credit of the same currency and amount,
 *    a matching merchant, dated on/after the purchase and within 180 days) → the bank refunded with
 *    a real line, so the annulment is kept as the PURCHASE and its synthetic refund is dropped
 *    (`bank_credit`, `annulled_on` = the credit's day): purchase + one refund, never two refunds.
 * Each statement line settles at most one annulment and vice versa; `usedLineIds` (statement lines
 * a bucket line already matched) are never taken. Writes unless `dryRun`; a flow whose fold is not
 * possible (the annulment kept no flow) is reported `folded: false`.
 */
export function settleAnnulmentsAgainstStatement(
  accountId: number,
  statementLines: readonly StatementChargeLike[],
  usedLineIds: ReadonlySet<number>,
  opts?: { dryRun?: boolean }
): CcAnnulmentSettled[] {
  const open = listAnnulledPurchases(accountId);
  const out: CcAnnulmentSettled[] = [];
  for (const s of planAnnulmentSettlements(open, statementLines, usedLineIds)) {
    const a = s.annulment;
    if (s.outcome === "billed") {
      let folded = false;
      if (!opts?.dryRun) {
        const survivor = a.flow_id;
        const arriving = rowFlowId("cc_statement_lines", s.statement_line_id);
        if (flowExists(survivor) && flowExists(arriving) && survivor !== arriving) {
          adoptFlow(
            { survivor, arriving },
            { prefer: "survivor", key: resolveCcExpensePurchaseKey(s.statement_line_id), previousKey: a.purchase_key }
          );
          folded = true;
        }
        deleteAnnulledPurchase(a.id);
      }
      out.push({ annulled_purchase_id: a.id, outcome: "billed", statement_line_id: s.statement_line_id, folded });
      continue;
    }
    if (!opts?.dryRun) markAnnulledPurchaseBankCredited(a.id, s.credit_iso);
    out.push({ annulled_purchase_id: a.id, outcome: "bank_credit", statement_line_id: s.statement_line_id, folded: false });
  }
  return out;
}

/** An annulled purchase as the statement settlement reads it. */
export type AnnulmentForSettlement = Pick<CcAnnulledPurchase, "id" | "currency" | "amount" | "merchant" | "purchase_date" | "bank_credit" | "flow_id" | "purchase_key">;

/** What a statement does to one annulment ({@link settleAnnulmentsAgainstStatement}). */
export type AnnulmentSettlementDecision<A extends AnnulmentForSettlement> =
  | { annulment: A; outcome: "billed"; statement_line_id: number }
  | { annulment: A; outcome: "bank_credit"; statement_line_id: number; credit_iso: string };

/**
 * The settlement rule of {@link settleAnnulmentsAgainstStatement}, pure: `annulments` in the order
 * the card lists them (purchase day, then id); bank-credited ones are skipped.
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
