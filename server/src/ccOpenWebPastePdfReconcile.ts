import { billingMonthForCcStatement } from "./cards/statementMonth.js";
import { ccStatementSourceKindOf, isListingSourceKind, isStatementSourceKind } from "./ccStatementSourceKind.js";
import { applyCardLinePlan } from "./ccCrossImportDedupe.js";
import { noteCardLineWritten, withCardLineSession } from "./cards/lineWriteSession.js";
import {
  hasEveryStatementTwinForBillingMonth,
  statementSlotsByBillingMonth,
} from "./ccBillingStatementSlots.js";
import { requiredStatementCurrenciesForAccount, billingMonthForManualLedgerPurchase } from "./cards/facturacion.js";
import { nextPeriodStartIsoForBillingMonth } from "./cards/facturacion.js";
import {
  moveOpenBucketLinesToBillingMonth,
  parseOpenWebPasteBillingMonth,
} from "./ccOpenWebPasteRepair.js";
import { merchantsMatchForCrossDedupe } from "./cards/purchases.js";
import {
  confirmManualPaymentForPlanted,
  listPlantedPaymentLines,
  plantedPaymentMatchesStatementLine,
  type PlantedPaymentRow,
} from "./ccPlantedPayments.js";
import type { CardCanonicalStatement } from "nw-tracker-contracts";
import {
  listCcStatementLinesForStatement,
  listCcStatementsForAccount,
  type CcStatementLineRow,
  type CcStatementRow,
} from "./ccStatementsDb.js";
import { dayWithinWindow, parseDdMmYyToIso } from "nw-tracker-contracts";
import { annulOpenBucketLines } from "./ccAnnulledPurchases.js";
import {
  bucketLineAnnullableGiven,
  bucketLineCuotaPurchaseKind,
  settleAnnulmentsAgainstStatement,
  statementLineRestatingBucketLine,
  type CcAnnulmentSettled,
  type StatementChargeLike,
} from "./ccAnnulmentWriters.js";
import { findPlanForOneShotLine } from "./cards/purchases.js";
import { carryPlanPrepaymentLines } from "./ccPlanPrepayments.js";
import { planPrepaymentRows } from "./ccPlanPrepaymentsRead.js";
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

export type CcOpenWebPastePdfReconcileResult = {
  billing_month: string;
  /**
   * Bucket currencies settled: every line once the month is fully closed, else only the lines in
   * a currency whose statement is in (one twin arriving before the other).
   */
  currencies: string[];
  deleted_count: number;
  deleted_line_ids: number[];
  /** Earliest purchase date among the deleted lines — evidence the owed walk must re-read from. */
  earliest_deleted_iso: string | null;
  /** Bucket lines the statement did not bill (after its cycle) moved to the open facturación. */
  moved_count: number;
  moved_line_ids: number[];
  /**
   * Bucket lines inside the billed cycle that the statement neither bills nor restates: the bank
   * dropped them, so they are kept as annulled purchases (a subset of `deleted_line_ids`).
   */
  annulled_line_ids: number[];
  /** Annulled purchases the statement billed after all or refunded with a real credit. */
  annulments_settled: CcAnnulmentSettled[];
  /**
   * Bucket lines of a plan the bank paid off at once (the prepayment, its refund credit) that the
   * statement does not print: kept, never deleted or annulled — they are no purchases (`ccPlanPrepayments.ts`).
   */
  kept_plan_prepayment_line_ids: number[];
  skipped: boolean;
  skip_reason: string | null;
};

/**
 * Supersede the `open|{M}` web-paste bucket once a statement closes billing month M.
 *
 * The bucket is a placeholder for the in-progress cycle; the statement is authoritative once it
 * arrives. Each bucket line is settled against it:
 *
 *  - **On the statement** (same merchant, amount to the unit, date within a day — see
 *    {@link webPasteLineMatchesStatementLine}) → deleted, the statement carries it.
 *  - **Inside the billed cycle but not on the statement** → web-paste amounts are
 *    pre-authorization snapshots that don't line up one-to-one with settled lines (several
 *    grocery pre-auths collapse into one charge), so a statement line of the same currency within
 *    four days that has a matching merchant (another amount) or the same amount (another name)
 *    means the statement carries it under another shape → deleted. With no such line the bank
 *    voided the purchase and billed nothing for it: it is kept as an ANNULLED purchase (basis
 *    `statement_close`, annulled on the close day; `ccAnnulledPurchases.ts`) instead of deleted.
 *    A cuota line, a line tagged as a cuota purchase, a line a plan covers and any credit or
 *    payment keep the delete (the statement's plan or its own line supersedes them).
 *  - **A previously annulled purchase** the statement bills after all → the annulment goes and its
 *    flow folds into the statement line; one the statement refunds with a real credit keeps the
 *    purchase and drops its synthetic refund (`settleAnnulmentsAgainstStatement`).
 *  - **Outside the billed cycle and not on the statement** → moved to the open facturación: the
 *    bank did not bill it at this close. The cycle ends BEFORE the next cycle's first day
 *    (`nextPeriodStartIsoForBillingMonth`), which is the close day itself on Santander — a
 *    purchase dated the close day bills next month (24/09/2026 rows sat in «por facturar» the day
 *    after the September close) — and the day after it on BCI. Deleting on the close day, as the
 *    old inclusive window did, dropped those purchases until the next feed re-listed them.
 *
 * Lines already filed in a LATER bucket (the post-close feed moved them forward) are only
 * deleted when the statement carries them after all. Falls back to exact matching alone when the
 * statement lacks a parseable period.
 *
 * Before the month is fully closed (one twin in, the other pending) only the lines in the
 * statement's own currency are settled; the rest wait for their statement.
 */
export function reconcileOpenWebPasteAfterPdfClose(
  accountId: number,
  billingMonth: string,
  opts?: { dryRun?: boolean }
): CcOpenWebPastePdfReconcileResult {
  const statements = listCcStatementsForAccount(accountId);
  const pdfStatements = statements.filter(
    (st) => st.billing_month === billingMonth && isStatementSourceKind(st.source_kind)
  );
  if (pdfStatements.length === 0) {
    return {
      billing_month: billingMonth,
      currencies: [],
      deleted_count: 0,
      deleted_line_ids: [],
      earliest_deleted_iso: null,
      moved_count: 0,
      moved_line_ids: [],
      annulled_line_ids: [],
      annulments_settled: [],
      kept_plan_prepayment_line_ids: [],
      skipped: true,
      skip_reason: "no_pdf_lines_for_billing_month",
    };
  }
  const plan = planBucketSettlement(loadBucketSettlementInput(accountId, billingMonth, statements, pdfStatements));
  const { toDelete, toMove, toAnnul, settledBy, plantedConfirmations, keptPrepaymentLines, matchable } = plan;
  const planted = new Map(listPlantedPaymentLines(accountId).map((p) => [p.line_id, p]));
  let annulmentsSettled = settleAnnulmentsAgainstStatement(accountId, matchable, new Set(), { dryRun: true });

  if (!opts?.dryRun) {
    // A planted payment the statement prints is confirmed; one deleted unmatched is not (the
    // manual payment's overdue check then surfaces it).
    const deleting = new Set(toDelete);
    for (const c of plantedConfirmations) {
      if (deleting.has(c.lineId)) confirmManualPaymentForPlanted(planted.get(c.lineId)!, c.merchant);
    }
    // A card-line write (the statement import's, when it runs inside one): the settled lines'
    // assignments carried onto the statement's lines, then deleted; the unbilled ones moved on.
    withCardLineSession(accountId, "statement bucket reconcile", () => {
      // Annulment rows first: they snapshot the lines the plan below deletes.
      if (toAnnul.length > 0) {
        const evidence = pdfStatements[0]!.source_pdf;
        for (const { id, annulledOn } of toAnnul) {
          annulOpenBucketLines(accountId, [id], { annulledOn, basis: "statement_close", evidence });
        }
      }
      annulmentsSettled = settleAnnulmentsAgainstStatement(accountId, matchable, new Set());
      // The prepayment and its credit follow their line onto the statement line that bills it.
      carryPlanPrepaymentLines(accountId, settledBy);
      applyCardLinePlan(accountId, { deleteLineIds: toDelete, carry: settledBy });
      if (toMove.length > 0) {
        const openBm = billingMonthForManualLedgerPurchase(accountId);
        if (!openBm) throw new Error(`Account ${accountId}: no open facturación to move lines into`);
        moveOpenBucketLinesToBillingMonth(accountId, toMove, openBm);
        noteCardLineWritten(accountId);
      }
    });
  }

  return {
    billing_month: billingMonth,
    currencies: plan.fullyClosed ? ["clp", "usd"] : [...plan.statementCurrencies].sort(), // convention-ok: the web-paste bucket holds Santander/BCI listing lines in pesos or dollars only
    deleted_count: toDelete.length,
    deleted_line_ids: toDelete,
    earliest_deleted_iso: plan.earliestDeletedIso,
    moved_count: toMove.length,
    moved_line_ids: toMove,
    annulled_line_ids: toAnnul.map((a) => a.id),
    annulments_settled: annulmentsSettled,
    kept_plan_prepayment_line_ids: keptPrepaymentLines,
    skipped: false,
    skip_reason: null,
  };
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
};

/**
 * The bucket's settlement against the month's statements (pure; the rule is
 * {@link reconcileOpenWebPasteAfterPdfClose}'s). `reconcileOpenWebPasteAfterPdfClose` runs it on the
 * lines on file once the statement's lines are written; the statement-line planner
 * (`cards/statementLinePlan.ts`) runs it on the lines as they will be.
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
  for (const { line, purchaseIso, sourceKind } of inCycleUnmatched) {
    remove(line, purchaseIso);
    const isBucket = sourceKind === "listing_open" || sourceKind === "listing_other";
    if (!isBucket || !bucketLineAnnullableGiven(line, input.cuotaPurchaseKind(line.id))) continue;
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
  };
}

/** {@link planBucketSettlement}'s input from the lines on file (`statements`: the account's, as listed). */
function loadBucketSettlementInput(
  accountId: number,
  billingMonth: string,
  statements: readonly CcStatementRow[],
  pdfStatements: readonly CcStatementRow[]
): BucketSettlementInput<CcStatementLineRow> {
  // The month closes only once every statement currency the account carries is in, but one twin
  // is already the bank's word on its OWN currency: settle that currency's bucket lines now and
  // leave the others for their statement. Keeping the whole bucket until the second twin (the
  // rule until 2026-09-26) counted the first twin's lines twice meanwhile — the September 2026
  // ·0781 USD statement arrived hours before its CLP twin, and importing it alone read the
  // month's dollar purchases twice (US$x.xxx,xx billed for US$x.xxx,xx).
  const fullyClosed = hasEveryStatementTwinForBillingMonth(
    statementSlotsByBillingMonth(accountId).get(billingMonth),
    requiredStatementCurrenciesForAccount(accountId)
  );
  const prepaymentRoles = new Map<number, PlanPrepaymentLineRole>();
  for (const r of planPrepaymentRows(accountId)) {
    if (r.line_id != null) prepaymentRoles.set(r.line_id, "prepayment");
    if (r.credit_line_id != null) prepaymentRoles.set(r.credit_line_id, "credit");
  }
  const buckets = statements
    .map((st) => ({ st, bm: parseOpenWebPasteBillingMonth(st.source_pdf) }))
    .filter((b): b is { st: CcStatementRow; bm: string } => b.bm != null)
    .sort((a, b) => a.bm.localeCompare(b.bm))
    .map(({ st, bm }) => ({ billingMonth: bm, sourceKind: st.source_kind, lines: listCcStatementLinesForStatement(st.id) }));
  return {
    billingMonth,
    fullyClosed,
    statementCurrencies: new Set<string>(pdfStatements.map((st) => st.currency)),
    closedPeriod: closedPeriodIsoRange(pdfStatements),
    nextStart: nextPeriodStartIsoForBillingMonth(accountId, billingMonth, statements).iso,
    statementLines: statementLinesForMatching(pdfStatements),
    buckets,
    planted: new Map(listPlantedPaymentLines(accountId).map((p) => [p.line_id, p])),
    prepaymentRoles,
    cuotaPurchaseKind: bucketLineCuotaPurchaseKind,
    planCoversOneShot: (merchant, iso, amount) => findPlanForOneShotLine(accountId, merchant, iso, amount) != null,
  };
}


/** A bucket line's currency: the one it stores. */
function bucketLineCurrency(line: { currency: string }): string {
  return listingLineCurrency(line);
}

function statementLinesForMatching(
  pdfStatements: readonly CcStatementRow[]
): StatementLineForMatching<CcStatementLineRow>[] {
  const out: StatementLineForMatching<CcStatementLineRow>[] = [];
  for (const st of pdfStatements) {
    for (const line of listCcStatementLinesForStatement(st.id)) {
      if (line.installment_flag) continue;
      out.push({ line, currency: st.currency });
    }
  }
  return out;
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

function sameBucketLineFigures(web: BucketSettlementLine, stmt: StatementLineForMatching): boolean {
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

export function reconcileOpenWebPasteAfterPdfImports(
  accountId: number,
  statements: readonly CardCanonicalStatement[],
  opts?: { dryRun?: boolean }
): CcOpenWebPastePdfReconcileResult[] {
  const months = pdfClosedBillingMonthsFromImport(statements);
  return months.map((bm) => reconcileOpenWebPasteAfterPdfClose(accountId, bm, opts));
}
