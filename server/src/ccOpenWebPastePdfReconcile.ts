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
  bucketLineAnnullable,
  settleAnnulmentsAgainstStatement,
  statementRestatesBucketLine,
  type CcAnnulmentSettled,
} from "./ccAnnulmentWriters.js";
import { findPlanForOneShotLine } from "./cards/purchases.js";
import { MATCH_WINDOWS } from "./matching/windows.js";

function fieldToIso(raw: string | null | undefined): string | null {
  const t = String(raw ?? "").trim();
  if (!t) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return t;
  return parseDdMmYyToIso(t);
}

function linePurchaseIso(line: CcStatementLineRow): string | null {
  return fieldToIso(line.transaction_date) ?? fieldToIso(line.posting_date);
}

/** Inclusive [from, to] ISO period covered by the PDF close(s) for a billing month. */
function closedPeriodIsoRange(
  pdfStatements: ReturnType<typeof listCcStatementsForAccount>
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
  currencies: ("clp" | "usd")[]; // convention-ok: the web-paste bucket holds Santander/BCI listing lines in pesos or dollars only
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
      skipped: true,
      skip_reason: "no_pdf_lines_for_billing_month",
    };
  }
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
  const statementCurrencies = new Set<"clp" | "usd">( // convention-ok: the web-paste bucket holds Santander/BCI listing lines in pesos or dollars only
    pdfStatements.map((st) => (st.currency === "usd" ? "usd" : "clp")) // convention-ok: the web-paste bucket holds Santander/BCI listing lines in pesos or dollars only
  );
  const settles = (line: CcStatementLineRow): boolean =>
    fullyClosed || statementCurrencies.has(bucketLineCurrency(line));

  const closedPeriod = closedPeriodIsoRange(pdfStatements);
  const nextStart = nextPeriodStartIsoForBillingMonth(accountId, billingMonth, statements).iso;
  const statementLines = statementLinesForMatching(pdfStatements);
  const used = new Set<number>();
  // The statement line that bills each settled bucket line: its category, big group, note and
  // splits follow it there (the merchants differ — cut at 15, glued charge-type columns).
  const settledBy: { fromLineId: number; toLineId: number }[] = [];
  // A payment the app planted (receipt, entered by hand) may print under another wording and a
  // few days later: it matches by currency, amount and window (ccPlantedPayments.ts).
  const planted = new Map(listPlantedPaymentLines(accountId).map((p) => [p.line_id, p]));
  const plantedConfirmations: { lineId: number; merchant: string }[] = [];
  const takeMatch = (line: CcStatementLineRow): boolean => {
    const plantedRow = planted.get(line.id);
    const hit = statementLines.find(
      (s) =>
        !used.has(s.line.id) &&
        (webPasteLineMatchesStatementLine(line, s) ||
          (plantedRow != null && plantedPaymentMatchesStatementLine(plantedRow, s.line, s.currency)))
    );
    if (!hit) return false;
    used.add(hit.line.id);
    settledBy.push({ fromLineId: line.id, toLineId: hit.line.id });
    if (plantedRow) plantedConfirmations.push({ lineId: line.id, merchant: String(hit.line.merchant ?? "") });
    return true;
  };

  const toDelete: number[] = [];
  const toMove: number[] = [];
  const inCycleUnmatched: { line: CcStatementLineRow; purchaseIso: string; st: CcStatementRow }[] = [];
  let earliestDeleted: string | null = null;
  const remove = (line: CcStatementLineRow, purchaseIso: string | null): void => {
    toDelete.push(line.id);
    if (purchaseIso && (earliestDeleted == null || purchaseIso < earliestDeleted)) {
      earliestDeleted = purchaseIso;
    }
  };
  const buckets = statements
    .map((st) => ({ st, bm: parseOpenWebPasteBillingMonth(st.source_pdf) }))
    .filter((b): b is { st: CcStatementRow; bm: string } => b.bm != null)
    .sort((a, b) => a.bm.localeCompare(b.bm));
  for (const { st, bm } of buckets) {
    if (bm.localeCompare(billingMonth) < 0) continue;
    const laterBucket = bm !== billingMonth;
    for (const line of listCcStatementLinesForStatement(st.id)) {
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
        inCycleUnmatched.push({ line, purchaseIso, st });
      } else {
        toMove.push(line.id);
      }
    }
  }

  // The in-cycle lines no statement line took: restated by one, or voided by the bank.
  const matchable = statementLines
    .filter((s) => !used.has(s.line.id))
    .map((s) => ({
      id: s.line.id,
      merchant: s.line.merchant,
      amount_clp: s.line.amount_clp,
      amount_usd: s.line.amount_usd,
      iso: linePurchaseIso(s.line),
      currency: s.currency,
    }));
  const toAnnul: { id: number; iso: string }[] = [];
  for (const { line, purchaseIso, st } of inCycleUnmatched) {
    remove(line, purchaseIso);
    const isBucket = st.source_kind === "listing_open" || st.source_kind === "listing_other";
    if (
      isBucket &&
      bucketLineAnnullable(line) &&
      !findPlanForOneShotLine(
        accountId,
        line.merchant,
        purchaseIso,
        Math.abs(Math.trunc((lineUsdAmount(line) != null ? 0 : line.amount_clp) ?? 0))
      ) &&
      !statementRestatesBucketLine(
        { merchant: line.merchant, amount_clp: line.amount_clp, amount_usd: line.amount_usd, iso: purchaseIso },
        matchable
      )
    ) {
      toAnnul.push({ id: line.id, iso: purchaseIso });
    }
  }
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
        const annulledOn = closedPeriod!.to;
        for (const { id, iso } of toAnnul) {
          annulOpenBucketLines(accountId, [id], {
            annulledOn: iso > annulledOn ? iso : annulledOn,
            basis: "statement_close",
            evidence,
          });
        }
      }
      annulmentsSettled = settleAnnulmentsAgainstStatement(accountId, matchable, new Set());
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
    currencies: fullyClosed ? ["clp", "usd"] : [...statementCurrencies].sort(), // convention-ok: the web-paste bucket holds Santander/BCI listing lines in pesos or dollars only
    deleted_count: toDelete.length,
    deleted_line_ids: toDelete,
    earliest_deleted_iso: earliestDeleted,
    moved_count: toMove.length,
    moved_line_ids: toMove,
    annulled_line_ids: toAnnul.map((a) => a.id),
    annulments_settled: annulmentsSettled,
    skipped: false,
    skip_reason: null,
  };
}

type StatementLineForMatching = { line: CcStatementLineRow; currency: "clp" | "usd" }; // convention-ok: the web-paste bucket holds Santander/BCI listing lines in pesos or dollars only

/** A bucket line's currency: pasted / fed foreign purchases carry `amount_usd` (and 0 CLP). */
function bucketLineCurrency(line: CcStatementLineRow): "clp" | "usd" { // convention-ok: the web-paste bucket holds Santander/BCI listing lines in pesos or dollars only
  return line.amount_usd != null && line.amount_usd !== 0 ? "usd" : "clp";
}

function statementLinesForMatching(
  pdfStatements: readonly CcStatementRow[]
): StatementLineForMatching[] {
  const out: StatementLineForMatching[] = [];
  for (const st of pdfStatements) {
    for (const line of listCcStatementLinesForStatement(st.id)) {
      if (line.installment_flag) continue;
      out.push({ line, currency: st.currency === "usd" ? "usd" : "clp" }); // convention-ok: the web-paste bucket holds Santander/BCI listing lines in pesos or dollars only
    }
  }
  return out;
}

function lineUsdAmount(line: CcStatementLineRow): number | null {
  const usd = line.amount_usd;
  return usd != null && usd !== 0 ? usd : null;
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
  web: CcStatementLineRow,
  stmt: StatementLineForMatching
): boolean {
  if (web.installment_flag || stmt.line.installment_flag) return false;
  const webUsd = lineUsdAmount(web);
  const stmtUsd = stmt.currency === "usd" ? lineUsdAmount(stmt.line) : null; // convention-ok: the web-paste bucket holds Santander/BCI listing lines in pesos or dollars only
  if (webUsd != null || stmtUsd != null) {
    if (webUsd == null || stmtUsd == null || Math.abs(webUsd - stmtUsd) > 0.005) return false;
  } else {
    const a = web.amount_clp;
    const b = stmt.line.amount_clp;
    if (a == null || b == null || a === 0 || Math.round(a) !== Math.round(b)) return false;
  }
  const wd = linePurchaseIso(web);
  const sd = linePurchaseIso(stmt.line);
  if (!wd || !sd) return false;
  if (!dayWithinWindow(sd, wd, MATCH_WINDOWS.statement_bucket_line)) return false;
  return merchantsMatchForCrossDedupe(web.merchant, stmt.line.merchant);
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
