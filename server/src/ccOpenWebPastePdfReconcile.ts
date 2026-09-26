import { billingMonthForCcStatement } from "./ccBillingMonth.js";
import { recomputeCcBillingMonthBalances } from "./ccBillingBalances.js";
import { deleteStatementLinesByIds } from "./ccCrossImportDedupe.js";
import { parseDdMmYyToIso } from "./ccInstallmentPayBy.js";
import {
  hasEveryStatementTwinForBillingMonth,
  statementSlotsByBillingMonth,
} from "./ccBillingStatementSlots.js";
import {
  accountRequiresUsdStatementClose,
  billingMonthForManualLedgerPurchase,
  isPdfStatementSource,
  pdfClosedBillingMonthsForAccount,
} from "./ccManualBillingMonth.js";
import { nextPeriodStartIsoForBillingMonth } from "./ccBillingCloses.js";
import {
  moveOpenBucketLinesToBillingMonth,
  parseOpenWebPasteBillingMonth,
} from "./ccOpenWebPasteRepair.js";
import { merchantsMatchForCrossDedupe } from "./ccCrossImportDedupe.js";
import type { CcStatementCsvRecord } from "./ccStatementsImport.js";
import {
  listCcStatementLinesForStatement,
  listCcStatementsForAccount,
  type CcStatementLineRow,
  type CcStatementRow,
} from "./ccStatementsDb.js";

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
  currencies: ("clp" | "usd")[];
  deleted_count: number;
  deleted_line_ids: number[];
  /** Earliest purchase date among the deleted lines — evidence the owed walk must re-read from. */
  earliest_deleted_iso: string | null;
  /** Bucket lines the statement did not bill (after its cycle) moved to the open facturación. */
  moved_count: number;
  moved_line_ids: number[];
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
 *  - **Inside the billed cycle but not on the statement** → deleted. Web-paste amounts are
 *    pre-authorization snapshots that don't line up one-to-one with settled lines (several
 *    grocery pre-auths collapse into one charge), so a missing twin inside the cycle means the
 *    statement carries it under another shape.
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
  opts?: { dryRun?: boolean; skipRecompute?: boolean }
): CcOpenWebPastePdfReconcileResult {
  const statements = listCcStatementsForAccount(accountId);
  const pdfStatements = statements.filter(
    (st) => st.billing_month === billingMonth && isPdfStatementSource(st.source_pdf)
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
    accountRequiresUsdStatementClose(accountId)
  );
  const statementCurrencies = new Set<"clp" | "usd">(
    pdfStatements.map((st) => (st.currency === "usd" ? "usd" : "clp"))
  );
  const settles = (line: CcStatementLineRow): boolean =>
    fullyClosed || statementCurrencies.has(bucketLineCurrency(line));

  const closedPeriod = closedPeriodIsoRange(pdfStatements);
  const nextStart = nextPeriodStartIsoForBillingMonth(accountId, billingMonth, statements).iso;
  const statementLines = statementLinesForMatching(pdfStatements);
  const used = new Set<number>();
  const takeMatch = (line: CcStatementLineRow): boolean => {
    const hit = statementLines.find(
      (s) => !used.has(s.line.id) && webPasteLineMatchesStatementLine(line, s)
    );
    if (!hit) return false;
    used.add(hit.line.id);
    return true;
  };

  const toDelete: number[] = [];
  const toMove: number[] = [];
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
        remove(line, purchaseIso);
      } else {
        toMove.push(line.id);
      }
    }
  }

  if (!opts?.dryRun) {
    if (toDelete.length > 0) deleteStatementLinesByIds(toDelete);
    if (toMove.length > 0) {
      const openBm = billingMonthForManualLedgerPurchase(accountId);
      if (!openBm) throw new Error(`Account ${accountId}: no open facturación to move lines into`);
      moveOpenBucketLinesToBillingMonth(accountId, toMove, openBm);
    }
    if ((toDelete.length > 0 || toMove.length > 0) && !opts?.skipRecompute) {
      recomputeCcBillingMonthBalances(accountId);
    }
  }

  return {
    billing_month: billingMonth,
    currencies: fullyClosed ? ["clp", "usd"] : [...statementCurrencies].sort(),
    deleted_count: toDelete.length,
    deleted_line_ids: toDelete,
    earliest_deleted_iso: earliestDeleted,
    moved_count: toMove.length,
    moved_line_ids: toMove,
    skipped: false,
    skip_reason: null,
  };
}

type StatementLineForMatching = { line: CcStatementLineRow; currency: "clp" | "usd" };

/** A bucket line's currency: pasted / fed foreign purchases carry `amount_usd` (and 0 CLP). */
function bucketLineCurrency(line: CcStatementLineRow): "clp" | "usd" {
  return line.amount_usd != null && line.amount_usd !== 0 ? "usd" : "clp";
}

function statementLinesForMatching(
  pdfStatements: readonly CcStatementRow[]
): StatementLineForMatching[] {
  const out: StatementLineForMatching[] = [];
  for (const st of pdfStatements) {
    for (const line of listCcStatementLinesForStatement(st.id)) {
      if (line.installment_flag) continue;
      out.push({ line, currency: st.currency === "usd" ? "usd" : "clp" });
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
  const stmtUsd = stmt.currency === "usd" ? lineUsdAmount(stmt.line) : null;
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
  const gapDays = Math.abs(Date.parse(`${wd}T00:00:00Z`) - Date.parse(`${sd}T00:00:00Z`)) / 86_400_000;
  if (gapDays > 1) return false;
  return merchantsMatchForCrossDedupe(web.merchant, stmt.line.merchant);
}

export function pdfClosedBillingMonthsFromImportRecords(
  records: readonly CcStatementCsvRecord[]
): string[] {
  const months = new Set<string>();
  for (const row of records) {
    const sourcePdf = String(row.source_pdf ?? "").trim();
    if (sourcePdf.startsWith("import:web-paste")) continue;
    const bm = billingMonthForCcStatement({
      statement_date: row.statement_date,
      period_to: row.period_to,
    });
    if (bm) months.add(bm);
  }
  return [...months].sort();
}

export function reconcileOpenWebPasteAfterPdfImports(
  accountId: number,
  records: readonly CcStatementCsvRecord[],
  opts?: { dryRun?: boolean; skipRecompute?: boolean }
): CcOpenWebPastePdfReconcileResult[] {
  const months = pdfClosedBillingMonthsFromImportRecords(records);
  return months.map((bm) => reconcileOpenWebPasteAfterPdfClose(accountId, bm, opts));
}

/**
 * Stale `open|{bm}` web-paste statements: a bucket before the current open month whose month a
 * STATEMENT closed — leftovers the reconcile could not place, attributed to the open month by the
 * read paths. A provisionally closed month's bucket is not stale: until its statement arrives its
 * lines are that month's only evidence (its facturado, the modal lines), so carrying them into
 * the open month would count them twice.
 */
export function listStaleOpenWebPasteStatementDates(
  accountId: number,
  openBillingMonth: string
): string[] {
  const dates: string[] = [];
  const pdfClosed = pdfClosedBillingMonthsForAccount(accountId);
  for (const st of listCcStatementsForAccount(accountId)) {
    const bucketBm = parseOpenWebPasteBillingMonth(st.source_pdf);
    if (!bucketBm) continue;
    if (bucketBm.localeCompare(openBillingMonth) >= 0) continue;
    if (!pdfClosed.has(bucketBm)) continue;
    dates.push(st.statement_date);
  }
  return dates;
}

/**
 * The facturación each statement's lines belong to, keyed by statement date — the unit every line
 * sum groups by (a facturación's CLP and USD twins share it): the statement's own billing month,
 * except a stale bucket ({@link listStaleOpenWebPasteStatementDates}), whose leftovers belong to the
 * open month. The one rule for «the lines of facturación M»: the open-month facturado and payment
 * sums, the expense lines' `billing_month` and through it the facturación modal all read it. The
 * client used to re-derive it with an older rule (every earlier bucket in every later month, a month
 * «closed» by any one statement), which listed September 2026's bucket under October's modal.
 */
export function facturacionMonthByStatementDate(accountId: number): Map<string, string> {
  const out = new Map<string, string>();
  for (const st of listCcStatementsForAccount(accountId)) {
    if (!st.billing_month) continue;
    const prev = out.get(st.statement_date);
    if (prev != null && prev !== st.billing_month) {
      throw new Error(
        `Account ${accountId}: statements dated ${st.statement_date} belong to ${prev} and ${st.billing_month}`
      );
    }
    out.set(st.statement_date, st.billing_month);
  }
  const openBm = billingMonthForManualLedgerPurchase(accountId);
  if (openBm) {
    for (const date of listStaleOpenWebPasteStatementDates(accountId, openBm)) out.set(date, openBm);
  }
  return out;
}

/** Statement dates whose lines belong to facturación `billingMonth` ({@link facturacionMonthByStatementDate}). */
export function statementDatesForFacturacion(accountId: number, billingMonth: string): string[] {
  const dates: string[] = [];
  for (const [date, bm] of facturacionMonthByStatementDate(accountId)) {
    if (bm === billingMonth) dates.push(date);
  }
  return dates;
}
