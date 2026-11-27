import { billingMonthForCcStatement } from "./cards/statementMonth.js";
import { ccStatementSourceKindOf, isListingSourceKind } from "./ccStatementSourceKind.js";
import { merchantsMatchForCrossDedupe } from "./cards/purchases.js";
import { plantedPaymentMatchesStatementLine, type PlantedPaymentRow } from "./ccPlantedPayments.js";
import type { CardCanonicalStatement } from "nw-tracker-contracts";
import type { CcStatementLineRow, CcStatementRow } from "./ccStatementsDb.js";
import { dayWithinWindow, daysBetweenIso, parseDdMmYyToIso } from "nw-tracker-contracts";
import { isPaymentLikeCreditMerchant } from "./ccPlantedPayments.js";
import { purchaseAmountsMatch } from "./matching/installmentAmount.js";
import { pairOneToOne } from "./matching/pairing.js";
import { bucketLineAnnullableGiven, statementLineRestatingBucketLine, type StatementChargeLike } from "./ccAnnulmentWriters.js";
import { listingLineCurrency } from "./ccFeedCuotaPurchases.js";
import { isHomeCurrency } from "./displayUnits.js";
import { sameCoin } from "./matching/money.js";
import { MATCH_WINDOWS } from "./matching/windows.js";

function fieldToIso(raw: string | null | undefined): string | null {
  const t = String(raw ?? "").trim();
  if (!t) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return t;
  return parseDdMmYyToIso(t);
}

export function linePurchaseIso(line: Pick<CcStatementLineRow, "transaction_date" | "posting_date">): string | null {
  return fieldToIso(line.transaction_date) ?? fieldToIso(line.posting_date);
}

/** Inclusive [from, to] ISO period covered by the PDF close(s) for a billing month. */
export function closedPeriodIsoRange(
  pdfStatements: readonly Pick<CcStatementRow, "period_from" | "period_to">[]
): { from: string; to: string } | null {
  let from: string | null = null;
  let to: string | null = null;
  for (const st of pdfStatements) {
    const f = fieldToIso(st.period_from);
    const t = fieldToIso(st.period_to);
    if (f && (from == null || f < from)) from = f;
    if (t && (to == null || t > to)) to = t;
  }
  return from && to ? { from, to } : null;
}

/** A bucket or statement line as the settlement reads it (`CcStatementLineRow`'s matching columns). */
export type BucketSettlementLine = Pick<
  CcStatementLineRow,
  "id" | "merchant" | "transaction_date" | "posting_date" | "amount" | "currency" | "installment_flag"
>;

/** A statement line with the currency of the statement it sits on. */
export type StatementLineForMatching<L extends BucketSettlementLine = BucketSettlementLine> = { line: L; currency: string };

/** Everything {@link planBucketSettlement} reads, once the statement's lines are on file. */
export type BucketSettlementInput<L extends BucketSettlementLine = BucketSettlementLine> = {
  billingMonth: string;
  /** Every statement currency of the month is in (else only the statements' own currencies settle). */
  fullyClosed: boolean;
  statementCurrencies: ReadonlySet<string>;
  /** Inclusive period of the month's statements; null when none prints one (exact matches only). */
  closedPeriod: { from: string; to: string } | null;
  /** The next cycle's first day (`nextPeriodStartIsoForBillingMonth`). */
  nextStart: string;
  /** The month's statement lines, one-shot only, in the reconcile's order (statement, then day text and id). */
  statementLines: readonly StatementLineForMatching<L>[];
  /** The open buckets of this month and later, by month; each bucket's lines in its order. */
  buckets: readonly { billingMonth: string; sourceKind: string; lines: readonly L[] }[];
  planted: ReadonlyMap<number, PlantedPaymentRow>;
  prepaymentRoles: ReadonlyMap<number, PlanPrepaymentLineRole>;
  /** A bucket line's `cuota_purchase_kind` tag. */
  cuotaPurchaseKind: (lineId: number) => string | null;
  /** Whether a plan on file is the peso one-shot line's purchase (`findPlanForOneShotLine`). */
  planCoversOneShot: (merchant: string | null, purchaseIso: string, amountClp: number) => boolean;
  /**
   * The plans the import's documents bring that no line has taken yet: a cuota-tagged bucket line
   * the exact plan match misses (another merchant, a day or two apart) hands its flow to the one
   * such plan of its principal near its day.
   */
  documentPlans: readonly { id: number; purchase_date: string; total_amount_clp: number }[];
};

/** What the statement does to the bucket ({@link planBucketSettlement}). */
export type BucketSettlementPlan = {
  fullyClosed: boolean;
  statementCurrencies: ReadonlySet<string>;
  closedPeriod: { from: string; to: string } | null;
  /** Bucket lines the statement settles, deleted (the annulled ones included). */
  toDelete: number[];
  earliestDeletedIso: string | null;
  /** Bucket lines outside the billed cycle, moved to the open facturación. */
  toMove: number[];
  /** Bucket lines kept as annulled purchases, with their annulment day. */
  toAnnul: { id: number; iso: string; annulledOn: string }[];
  /** Each settled bucket line and the statement line that bills it (its flow follows). */
  settledBy: { fromLineId: number; toLineId: number; by: "same_purchase" | "planted_payment" | "plan_prepayment" }[];
  plantedConfirmations: { lineId: number; merchant: string }[];
  keptPrepaymentLines: number[];
  /**
   * In-cycle bucket lines deleted because a statement line carries them under another shape
   * (`statementRestatesBucketLine`): the first such line, in `matchable` order.
   */
  restatedBy: { fromLineId: number; toLineId: number }[];
  /** The statement lines no bucket line took, as the annulment matchers read them. */
  matchable: StatementChargeLike[];
  /** Cuota-tagged bucket lines (removed) whose flow goes to the one document plan of their principal near their day. */
  taggedOntoPlan: { fromLineId: number; planId: number }[];
  /** Removed bucket lines a second-chance pairing found several candidates for (paired with none). */
  severalCandidates: number[];
};

/**
 * The bucket's settlement against the month's statements (pure): the `open|{M}` bucket is a
 * placeholder for the in-progress cycle; the statement is authoritative once it arrives, and each
 * bucket line is settled against it:
 *
 *  - **On the statement** (same merchant, amount to the unit, date within a day — see
 *    {@link webPasteLineMatchesStatementLine}) → the statement line's row (`settledBy`).
 *  - **Inside the billed cycle but not on the statement** → web-paste amounts are
 *    pre-authorization snapshots that don't line up one-to-one with settled lines (several
 *    grocery pre-auths collapse into one charge), so a statement line of the same currency within
 *    four days that has a matching merchant (another amount) or the same amount (another name)
 *    means the statement carries it under another shape → that line's row (`restatedBy`). With no
 *    such line the bank voided the purchase and billed nothing for it: it is kept as an ANNULLED
 *    purchase (basis `statement_close`, annulled on the close day; `ccAnnulledPurchases.ts`).
 *    A cuota line, a line a plan covers, a payment and a credit or cuota-tagged line with no
 *    second-chance pair are removed (the statement's plan or its own line supersedes them). The
 *    second chance, one to one or not at all (`mutual_unique`): a credit (a refund, a nota, never
 *    a card payment) is restated by the one unused statement credit of its currency and signed
 *    amount within four days (`restatedBy`); a cuota-tagged line goes to the one plan the
 *    documents bring of its principal within four days (`taggedOntoPlan`). Several candidates pair
 *    nothing and are reported (`severalCandidates`).
 *  - **A previously annulled purchase** (`matchable`, for `planAnnulmentSettlements`) the
 *    statement bills after all → the annulment goes and its flow is the statement line's; one the
 *    statement refunds with a real credit keeps the purchase and drops its synthetic refund.
 *  - **Outside the billed cycle and not on the statement** → moved to the open facturación: the
 *    bank did not bill it at this close. The cycle ends BEFORE the next cycle's first day
 *    (`nextPeriodStartIsoForBillingMonth`), which is the close day itself on Santander — a
 *    purchase dated the close day bills next month (24/09/2026 rows sat in «por facturar» the day
 *    after the September close) — and the day after it on BCI.
 *
 * Lines already filed in a LATER bucket (the post-close feed moved them forward) are only
 * settled when the statement carries them after all. Falls back to exact matching alone when the
 * statement lacks a parseable period.
 *
 * Before the month is fully closed (one twin in, the other pending) only the lines in the
 * statement's own currency are settled; the rest wait for their statement.
 *
 * The statement-line planner (`cards/statementLinePlan.ts`) runs it on the lines as the import will
 * leave them.
 */
export function planBucketSettlement<L extends BucketSettlementLine>(input: BucketSettlementInput<L>): BucketSettlementPlan {
  const { fullyClosed, statementCurrencies, closedPeriod, nextStart, statementLines, billingMonth } = input;
  const settles = (line: L): boolean => fullyClosed || statementCurrencies.has(bucketLineCurrency(line));
  const used = new Set<number>();
  const settledBy: BucketSettlementPlan["settledBy"] = [];
  const plantedConfirmations: { lineId: number; merchant: string }[] = [];
  const takeMatch = (line: L): boolean => {
    const plantedRow = input.planted.get(line.id);
    const prepaymentRole = input.prepaymentRoles.get(line.id);
    let by: BucketSettlementPlan["settledBy"][number]["by"] = "same_purchase";
    const hit = statementLines.find((s) => {
      if (used.has(s.line.id)) return false;
      if (webPasteLineMatchesStatementLine(line, s)) return (by = "same_purchase"), true;
      if (plantedRow != null && plantedPaymentMatchesStatementLine(plantedRow, s.line)) return (by = "planted_payment"), true;
      if (prepaymentRole != null && planPrepaymentLineMatchesStatementLine(line, prepaymentRole, s)) return (by = "plan_prepayment"), true;
      return false;
    });
    if (!hit) return false;
    used.add(hit.line.id);
    settledBy.push({ fromLineId: line.id, toLineId: hit.line.id, by });
    if (plantedRow) plantedConfirmations.push({ lineId: line.id, merchant: String(hit.line.merchant ?? "") });
    return true;
  };

  const keptPrepaymentLines: number[] = [];
  const toDelete: number[] = [];
  const toMove: number[] = [];
  const inCycleUnmatched: { line: L; purchaseIso: string; sourceKind: string }[] = [];
  let earliestDeleted: string | null = null;
  const remove = (line: L, purchaseIso: string | null): void => {
    toDelete.push(line.id);
    if (purchaseIso && (earliestDeleted == null || purchaseIso < earliestDeleted)) earliestDeleted = purchaseIso;
  };
  for (const bucket of input.buckets) {
    if (bucket.billingMonth.localeCompare(billingMonth) < 0) continue;
    const laterBucket = bucket.billingMonth !== billingMonth;
    for (const line of bucket.lines) {
      if (!settles(line)) continue;
      const purchaseIso = linePurchaseIso(line);
      if (laterBucket) {
        // Routed past this close by the feed or the per-line router: only the statement itself
        // can say the bank billed it here after all.
        const nearClose =
          closedPeriod != null &&
          purchaseIso != null &&
          purchaseIso >= closedPeriod.from &&
          purchaseIso <= closedPeriod.to;
        if (nearClose && takeMatch(line)) remove(line, purchaseIso);
        continue;
      }
      if (takeMatch(line)) {
        remove(line, purchaseIso);
        continue;
      }
      if (closedPeriod == null || purchaseIso == null) continue;
      if (purchaseIso >= closedPeriod.from && purchaseIso < nextStart) {
        // Not on the statement: the prepayment and its credit are no purchases the bank can void.
        if (input.prepaymentRoles.has(line.id)) {
          keptPrepaymentLines.push(line.id);
          continue;
        }
        inCycleUnmatched.push({ line, purchaseIso, sourceKind: bucket.sourceKind });
      } else {
        toMove.push(line.id);
      }
    }
  }

  // The in-cycle lines no statement line took: restated by one, or voided by the bank.
  const matchable: StatementChargeLike[] = statementLines
    .filter((s) => !used.has(s.line.id))
    .map((s) => ({
      id: s.line.id,
      merchant: s.line.merchant,
      // The line's own amount; a line in another currency than its statement's bills nothing there.
      amount: s.line.currency === s.currency ? s.line.amount : null,
      iso: linePurchaseIso(s.line),
      currency: s.currency,
    }));
  const toAnnul: BucketSettlementPlan["toAnnul"] = [];
  const restatedBy: BucketSettlementPlan["restatedBy"] = [];
  const credits: { line: L; iso: string }[] = [];
  const tagged: { line: L; iso: string }[] = [];
  for (const { line, purchaseIso, sourceKind } of inCycleUnmatched) {
    remove(line, purchaseIso);
    const isBucket = sourceKind === "listing_open" || sourceKind === "listing_other";
    if (!isBucket) continue;
    const cuotaKind = input.cuotaPurchaseKind(line.id);
    if (!bucketLineAnnullableGiven(line, cuotaKind)) {
      if (bucketCreditGetsSecondChance(line, cuotaKind)) credits.push({ line, iso: purchaseIso });
      else if (cuotaKind != null && taggedLineGetsSecondChance(line, purchaseIso, input.planCoversOneShot)) tagged.push({ line, iso: purchaseIso });
      continue;
    }
    // A cuota plan is a peso contract (`cc_installment_purchases.total_amount_clp`): only a peso line can be one's purchase.
    if (
      isHomeCurrency(line.currency) &&
      line.amount != null &&
      input.planCoversOneShot(line.merchant, purchaseIso, Math.abs(Math.trunc(line.amount)))
    ) {
      continue;
    }
    const restating = statementLineRestatingBucketLine(
      { id: line.id, merchant: line.merchant, currency: line.currency, amount: line.amount, iso: purchaseIso },
      matchable
    );
    if (restating) {
      restatedBy.push({ fromLineId: line.id, toLineId: restating.id });
      continue;
    }
    const annulledOn = closedPeriod!.to;
    toAnnul.push({ id: line.id, iso: purchaseIso, annulledOn: purchaseIso > annulledOn ? purchaseIso : annulledOn });
  }

  // A credit the statement prints under another merchant or a few days off (a refund, a nota): the
  // one unused statement credit of the same currency and signed amount within the window restates
  // it, when no other bucket credit fits that line either. Card payments are not credits here (the
  // planted-payment pairing and the payment evidence keys own them).
  const window = MATCH_WINDOWS.feed_mirror.daysAfter;
  const severalCandidates: number[] = [];
  const creditPairs = pairOneToOne(
    credits,
    matchable.filter((s) => s.amount != null && s.amount < 0 && s.iso != null && !isPaymentLikeCreditMerchant(s.merchant)),
    {
      strategy: "mutual_unique",
      accepts: (b, s) =>
        s.currency === bucketLineCurrency(b.line) &&
        sameCoin(s.amount!, b.line.amount!, s.currency) &&
        Math.abs(daysBetweenIso(b.iso, s.iso!)) <= window,
    }
  );
  for (const p of creditPairs.pairs) restatedBy.push({ fromLineId: p.left.line.id, toLineId: p.right.id });
  severalCandidates.push(...creditPairs.ambiguous.map((a) => a.left.line.id));

  // A cuota-tagged line the exact plan match missed: its flow goes to the one plan the documents
  // bring of its principal within the window of its day, when no other tagged line fits that plan.
  const planPairs = pairOneToOne(tagged, input.documentPlans, {
    strategy: "mutual_unique",
    accepts: (t, p) => purchaseAmountsMatch(p.total_amount_clp, t.line.amount!) && Math.abs(daysBetweenIso(t.iso, p.purchase_date)) <= window,
  });
  const taggedOntoPlan = planPairs.pairs.map((p) => ({ fromLineId: p.left.line.id, planId: p.right.id }));
  severalCandidates.push(...planPairs.ambiguous.map((a) => a.left.line.id));
  return {
    fullyClosed,
    statementCurrencies,
    closedPeriod,
    toDelete,
    earliestDeletedIso: earliestDeleted,
    toMove,
    toAnnul,
    settledBy,
    plantedConfirmations,
    keptPrepaymentLines,
    restatedBy,
    matchable,
    taggedOntoPlan,
    severalCandidates,
  };
}

/** A non-payment credit on the bucket (a refund, a nota): paired by its signed amount ({@link planBucketSettlement}). */
function bucketCreditGetsSecondChance(line: BucketSettlementLine, cuotaKind: string | null): boolean {
  if (line.installment_flag || cuotaKind != null) return false;
  if (line.amount == null || !(line.amount < 0)) return false;
  return !isPaymentLikeCreditMerchant(line.merchant);
}

/** A peso cuota-tagged one-shot purchase no plan on file matches exactly ({@link planBucketSettlement}). */
function taggedLineGetsSecondChance(
  line: BucketSettlementLine,
  iso: string,
  planCoversOneShot: BucketSettlementInput["planCoversOneShot"]
): boolean {
  if (line.installment_flag || !isHomeCurrency(line.currency) || line.amount == null || !(line.amount > 0)) return false;
  return !planCoversOneShot(line.merchant, iso, Math.abs(Math.trunc(line.amount)));
}

/** A bucket line's currency: the one it stores. */
function bucketLineCurrency(line: { currency: string }): string {
  return listingLineCurrency(line);
}

/**
 * The same purchase on the web-paste/feed side and on the statement: one-shot, same merchant
 * (`merchantsMatchForCrossDedupe` — the PDF's glued «(T)» / charge-type columns and the feed's
 * «, CITY» are tolerated), same signed amount in the line's currency (USD to the cent, CLP to the
 * peso), dated within a day of each other (a pending authorization restates a day later). The
 * date bound is what the cross-source reconcile matcher lacks — without it a monthly parking
 * charge of the same amount would match the previous month's.
 */
export function webPasteLineMatchesStatementLine(
  web: BucketSettlementLine,
  stmt: StatementLineForMatching
): boolean {
  return sameBucketLineFigures(web, stmt) && merchantsMatchForCrossDedupe(web.merchant, stmt.line.merchant);
}

/** Which side of a bank-prepaid plan a bucket line is (`cc_plan_prepayments`). */
export type PlanPrepaymentLineRole = "prepayment" | "credit";

/** The statement's own wording for each side of a prepaid plan. */
const PLAN_PREPAYMENT_STATEMENT_MERCHANT: Record<PlanPrepaymentLineRole, RegExp> = {
  prepayment: /^PREPAGO EN CUOTAS$/,
  credit: /^NOTA DE CREDITO$/,
};

/**
 * A bucket line of a plan the bank prepaid, against the statement line that bills it. The feed
 * lists the prepayment and its credit under the purchase's merchant («MP *MERCADOPAGO NT»), the
 * statement prints them as «PREPAGO EN CUOTAS» and «NOTA DE CREDITO» (·7817, 24/11/2026), so the
 * merchant test is the statement's wording for the line's side; currency, amount and day window
 * are any bucket line's.
 */
export function planPrepaymentLineMatchesStatementLine(
  web: BucketSettlementLine,
  role: PlanPrepaymentLineRole,
  stmt: StatementLineForMatching
): boolean {
  const printed = String(stmt.line.merchant ?? "").trim().toUpperCase().replace(/\s+/g, " ");
  return sameBucketLineFigures(web, stmt) && PLAN_PREPAYMENT_STATEMENT_MERCHANT[role].test(printed);
}

/** Same currency, amount to the coin, day within the bucket window: the settle figures of a bucket line against a statement line. */
export function sameBucketLineFigures(web: BucketSettlementLine, stmt: StatementLineForMatching): boolean {
  if (web.installment_flag || stmt.line.installment_flag) return false;
  const currency = bucketLineCurrency(web);
  if (currency !== stmt.currency) return false;
  // Each line's own amount; a statement line in another currency than its statement's is not that purchase.
  if (stmt.line.currency !== currency) return false;
  const a = web.amount;
  const b = stmt.line.amount;
  if (a == null || b == null || a === 0 || !sameCoin(a, b, currency)) return false;
  const wd = linePurchaseIso(web);
  const sd = linePurchaseIso(stmt.line);
  if (!wd || !sd) return false;
  return dayWithinWindow(sd, wd, MATCH_WINDOWS.statement_bucket_line);
}

export function pdfClosedBillingMonthsFromImport(statements: readonly CardCanonicalStatement[]): string[] {
  const months = new Set<string>();
  for (const st of statements) {
    if (st.lines.length === 0) continue;
    if (isListingSourceKind(ccStatementSourceKindOf(st.document))) continue;
    const bm = billingMonthForCcStatement({ statement_date: st.close, period_to: st.period_to });
    if (bm) months.add(bm);
  }
  return [...months].sort();
}
