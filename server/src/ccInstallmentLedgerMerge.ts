import { ccCardGroupOrDefault } from "./ccIssuers.js";
import { db } from "./db.js";
import { ccStatementSourceKindOf } from "./ccStatementSourceKind.js";
import { applyCardLinePlan, planOneShotLinesSupersededByInstallmentPurchases } from "./ccCrossImportDedupe.js";
import {
  isInstallmentContractSummaryMerchant,
  merchantStemForInstallmentDedupe,
} from "./ccInstallmentLineDedupe.js";
import { backfillMissingInstallmentPaymentsForPlans } from "./ccInstallmentPaymentBackfill.js";
import { resolveInstallmentPayByIso } from "./ccInstallmentPayBy.js";
import { ccDerivedPayByRuleForAccount } from "./ccIssuerForAccount.js";
import { importCcStatementsMerge, type CcStatementsMergeOpts } from "./ccStatementsImport.js";
import { storedCardLineAmounts } from "./cards/statementStorage.js";
import { reconcileManualInstallmentPurchasesAfterStatementImport } from "./ccManualInstallmentStatementReconcile.js";
import { assertFeedClosesMatchStatements } from "./ccBillingCloses.js";
import { repairMisplacedOpenWebPasteBuckets } from "./ccOpenWebPasteRepair.js";
import {
  reconcileOpenWebPasteAfterPdfImports,
  type CcOpenWebPastePdfReconcileResult,
} from "./ccOpenWebPastePdfReconcile.js";
import { assertCcImportReconcilesOrThrow } from "./ccStatementImportReconcile.js";
import {
  deleteJsonStatementsByIds,
  jsonOwnedClosesForAccount,
  listJsonOwnedStatementsForAccount,
  statementReplaceKey,
  padCcStatementDate,
} from "./ccStatementJsonSource.js";
import { learnGroceryBranchesFromCardLines, type GroceryBranchLearningResult } from "./groceryBranchLearning.js";
import { relinkCcTraspasoDeudaLinksForAccount } from "./ccTraspasoDeudaLinks.js";
import {
  adoptReimportedCardLines,
  captureCardLines,
  type ReimportedCardLinesResult,
} from "./flows/cardLineAdoption.js";
import { installmentPurchaseLedgerDedupeKey } from "./cards/purchases.js";
import { billingMonthForCcStatement } from "./cards/statementMonth.js";
import {
  cardStatementKey,
  parseDdMmYyToIso,
  storedCardLineDate,
  type CardCanonicalLine,
  type CardCanonicalStatement,
} from "nw-tracker-contracts";
import { noteCardLineEvidence, noteCardLineFinancingLinks, withCardLineSession } from "./cards/lineWriteSession.js";
import { planTruncatedMerchantDuplicateRemoval } from "./ccTruncatedMerchantDedupe.js";
import { planRecurringPendingReplacement, type RecurringPendingResult } from "./ccRecurringPendingLines.js";
import { replacePlantedPaymentLinesFromImport, type PlantedPaymentMatchResult } from "./ccPlantedPayments.js";

/** One line of an import with the statement it sits on. */
export type CardStatementLineRef = { statement: CardCanonicalStatement; line: CardCanonicalLine };

/** Every line of the given statements, each with its statement, in import order. */
export function statementLineRefs(statements: readonly CardCanonicalStatement[]): CardStatementLineRef[] {
  return statements.flatMap((statement) => statement.lines.map((line) => ({ statement, line })));
}

function installmentContractAmountClp({ line }: CardStatementLineRef): number {
  return Math.max(storedCardLineAmounts(line).amount_clp, line.installment?.total_amount ?? 0);
}

/** The statement rows of one installment plan: cuota N on one statement, N+1 on the next. */
export type CcInstallmentLoanChain = {
  loan_key: string;
  card_group: string;
  canonical_row_id: string;
  /** Occurrence among same-identity twin purchases, 0-based ({@link groupInstallmentLoanChains}). */
  twin_index: number;
  rows: CardStatementLineRef[];
};

function makeLoanKey(ref: CardStatementLineRef): string | null {
  const { statement, line } = ref;
  const cg = ccCardGroupOrDefault(statement.card_group);
  const iso = line.transaction_date;
  const amt = installmentContractAmountClp(ref);
  const nt = line.installment?.count ?? null;
  if (!iso || amt <= 0 || nt == null || nt <= 0) return null;
  const merch =
    merchantStemForInstallmentDedupe(line.merchant) ||
    merchantStemForInstallmentDedupe(line.description);
  if (!merch) return null;
  return `${cg}\t${iso}\t${amt}\t${nt}\t${merch.toUpperCase()}`;
}

function pickCanonicalForLoan(rows: readonly CardStatementLineRef[]): string {
  const ids = [...new Set(rows.map((r) => r.line.installment?.plan_id ?? "").filter(Boolean))].sort();
  return ids[0] ?? "unknown";
}

/** `#dupN` suffix the parser (and the statement-JSON importer) gives the Nth same-statement twin. */
function dedupeKeyOccurrence({ line }: CardStatementLineRef): number {
  const m = /#dup(\d+)$/.exec(String(line.document.dedupe_key ?? "").trim());
  return m ? Number(m[1]) : 0;
}

/**
 * Installment rows grouped into one chain per plan. A plan is its loan identity (card group,
 * purchase date, principal, cuota count, merchant stem) plus a twin index: identical purchases
 * made the same day each print one identical cuota line on every statement, so a row's twin
 * index is its occurrence among the same loan's same-cuota rows on its statement, ordered by
 * the `#dupN` suffix. The twins are indistinguishable, so pairing the Nth line of one statement
 * with the Nth line of the next is exact.
 */
export function groupInstallmentLoanChains(
  statements: readonly CardCanonicalStatement[]
): Map<string, CcInstallmentLoanChain> {
  const byStatementCuota = new Map<string, { loanKey: string; rows: CardStatementLineRef[] }>();
  for (const ref of statementLineRefs(statements)) {
    const { statement, line } = ref;
    if (!line.installment) continue;
    if (isInstallmentContractSummaryMerchant(line.merchant)) continue;
    if (installmentContractAmountClp(ref) <= 0) continue;
    const loanKey = makeLoanKey(ref);
    if (!loanKey) continue;
    const bucketKey = [loanKey, statement.document, statement.close, String(line.installment.number ?? "")].join("\t");
    const bucket = byStatementCuota.get(bucketKey) ?? { loanKey, rows: [] };
    bucket.rows.push(ref);
    byStatementCuota.set(bucketKey, bucket);
  }

  const chains = new Map<string, CcInstallmentLoanChain>();
  for (const { loanKey, rows } of byStatementCuota.values()) {
    const ordered = [...rows].sort(
      (a, b) =>
        dedupeKeyOccurrence(a) - dedupeKeyOccurrence(b) ||
        String(a.line.document.line_id ?? "").localeCompare(String(b.line.document.line_id ?? ""))
    );
    ordered.forEach((ref, twinIndex) => {
      const chainKey = `${loanKey}\t${twinIndex}`;
      const chain = chains.get(chainKey) ?? {
        loan_key: loanKey,
        card_group: ccCardGroupOrDefault(ref.statement.card_group),
        canonical_row_id: "",
        twin_index: twinIndex,
        rows: [],
      };
      chain.rows.push(ref);
      chains.set(chainKey, chain);
    });
  }
  for (const chain of chains.values()) chain.canonical_row_id = pickCanonicalForLoan(chain.rows);
  return chains;
}

function stmtSortKey(statementDate: string): number {
  const iso = parseDdMmYyToIso(statementDate);
  if (!iso) return 0;
  return Number(iso.replace(/-/g, ""));
}

/**
 * Twin plans of one purchase identity start billing on the same statement: identical purchases
 * made the same day print their first cuota together. A twin whose first statement payment
 * differs from its twin 0's is a misread duplicate line, or a twin set whose earlier statements
 * were imported before twin plans existed (backfill it with
 * `server/scripts/repair-cc-installment-twin-plans.ts`) — never a purchase of its own.
 */
function assertTwinPlansStartTogether(
  accountId: number,
  planIdsByLoan: ReadonlyMap<string, ReadonlyMap<number, number>>
): void {
  const firstStatementPayBy = db.prepare(
    `SELECT MIN(pay_by_date) AS first_pay_by FROM cc_installment_payments
     WHERE purchase_id = ? AND (parser_row_id IS NULL OR parser_row_id NOT LIKE 'synthetic:%')`
  );
  const firstPayBy = (purchaseId: number): string | null =>
    (firstStatementPayBy.get(purchaseId) as { first_pay_by: string | null }).first_pay_by;
  for (const [loanKey, planIdByTwin] of planIdsByLoan) {
    if (planIdByTwin.size <= 1) continue;
    const twin0 = planIdByTwin.get(0);
    if (twin0 == null) {
      throw new Error(
        `installment twin plans without a twin 0 on account ${accountId}: loan=${JSON.stringify(loanKey)}`
      );
    }
    const start = firstPayBy(twin0);
    for (const [twinIndex, purchaseId] of planIdByTwin) {
      const twinStart = firstPayBy(purchaseId);
      if (twinStart === start) continue;
      throw new Error(
        `installment twin plan ${purchaseId} (twin ${twinIndex}) on account ${accountId} first bills ` +
          `${twinStart}, its twin 0 plan ${twin0} first bills ${start}: loan=${JSON.stringify(loanKey)}. ` +
          `Twin plans start on the same statement — a misread duplicate line, or a twin set to ` +
          `backfill with server/scripts/repair-cc-installment-twin-plans.ts.`
      );
    }
  }
}

export type CcInstallmentLedgerMergeResult = {
  purchaseUpserts: number;
  /** Earliest `purchase_date` among contracts this run INSERTED (null when all deduped). */
  earliestNewPurchaseDate: string | null;
  paymentUpserts: number;
  gapFilled: number;
};

export type CcInstallmentLedgerMergeOpts = {
  /** Wipe ledger for account before merge (`import:cc-parsed --wipe`). */
  replaceLedger?: boolean;
};

export function mergeInstallmentLedgerFromStatements(
  accountId: number,
  statements: readonly CardCanonicalStatement[],
  opts?: CcInstallmentLedgerMergeOpts
): CcInstallmentLedgerMergeResult {
  return withCardLineSession(accountId, "installment ledger merge", () =>
    mergeInstallmentLedgerInSession(accountId, statements, opts)
  );
}

function mergeInstallmentLedgerInSession(
  accountId: number,
  statements: readonly CardCanonicalStatement[],
  opts?: CcInstallmentLedgerMergeOpts
): CcInstallmentLedgerMergeResult {
  const replaceLedger = opts?.replaceLedger === true;

  const byLoan = groupInstallmentLoanChains(statements);

  const insP = db.prepare(
    `INSERT INTO cc_installment_purchases (
       account_id, card_group, canonical_row_id, dedupe_key, parser_row_id_sample, source_pdf_sample,
       purchase_date, total_amount_clp, cuotas_totales, merchant, description_merged, matched_baseline_purchase_id, source,
       twin_index
     ) VALUES (
       @account_id, @card_group, @canonical_row_id, @dedupe_key, @parser_row_id_sample, @source_pdf_sample,
       @purchase_date, @total_amount_clp, @cuotas_totales, @merchant, @description_merged, @matched_baseline_purchase_id, 'pdf',
       @twin_index
     )
     ON CONFLICT(account_id, card_group, canonical_row_id) DO UPDATE SET
       twin_index = excluded.twin_index,
       dedupe_key = COALESCE(excluded.dedupe_key, dedupe_key),
       parser_row_id_sample = COALESCE(excluded.parser_row_id_sample, parser_row_id_sample),
       source_pdf_sample = COALESCE(excluded.source_pdf_sample, source_pdf_sample),
       purchase_date = excluded.purchase_date,
       total_amount_clp = CASE WHEN cc_installment_purchases.source = 'manual'
         THEN COALESCE(NULLIF(cc_installment_purchases.total_amount_clp, 0), excluded.total_amount_clp)
         ELSE excluded.total_amount_clp END,
       cuotas_totales = CASE WHEN cc_installment_purchases.source = 'manual'
         THEN COALESCE(NULLIF(cc_installment_purchases.cuotas_totales, 0), excluded.cuotas_totales)
         ELSE excluded.cuotas_totales END,
       merchant = COALESCE(NULLIF(cc_installment_purchases.merchant, ''), excluded.merchant),
       description_merged = COALESCE(NULLIF(cc_installment_purchases.description_merged, ''), excluded.description_merged),
       matched_baseline_purchase_id = excluded.matched_baseline_purchase_id`
  );

  const insPay = db.prepare(
    `INSERT INTO cc_installment_payments (
       purchase_id, pay_by_date, statement_date, statement_period_month, source_pdf, amount_clp, cuota_current, cuota_total, parser_row_id
     ) VALUES (
       @purchase_id, @pay_by_date, @statement_date, @statement_period_month, @source_pdf, @amount_clp, @cuota_current, @cuota_total, @parser_row_id
     )
     ON CONFLICT(purchase_id, pay_by_date) DO UPDATE SET
       statement_date = excluded.statement_date,
       statement_period_month = excluded.statement_period_month,
       source_pdf = excluded.source_pdf,
       amount_clp = excluded.amount_clp,
       cuota_current = excluded.cuota_current,
       cuota_total = excluded.cuota_total,
       parser_row_id = excluded.parser_row_id`
  );

  const selId = db.prepare(
    `SELECT id FROM cc_installment_purchases WHERE account_id = ? AND card_group = ? AND canonical_row_id = ?`
  );

  let purchaseUpserts = 0;
  let earliestNewPurchaseDate: string | null = null;
  let paymentUpserts = 0;
  const touchedPlanIds = new Set<number>();

  const run = db.transaction(() => {
    if (replaceLedger) {
      db.prepare(
        `DELETE FROM cc_installment_payments WHERE purchase_id IN (SELECT id FROM cc_installment_purchases WHERE account_id = ?)`
      ).run(accountId);
      db.prepare(`DELETE FROM cc_installment_purchases WHERE account_id = ? AND source != 'manual'`).run(
        accountId
      );
    }

    const purchaseIdByFingerprint = new Map<string, number>();
    for (const row of db
      .prepare(
        `SELECT id, purchase_date, total_amount_clp, cuotas_totales, merchant, twin_index
         FROM cc_installment_purchases WHERE account_id = ?`
      )
      .all(accountId) as {
      id: number;
      purchase_date: string;
      total_amount_clp: number;
      cuotas_totales: number;
      merchant: string | null;
      twin_index: number;
    }[]) {
      const fp = installmentPurchaseLedgerDedupeKey(row);
      const prev = purchaseIdByFingerprint.get(fp);
      if (prev == null || row.id < prev) purchaseIdByFingerprint.set(fp, row.id);
    }

    const planIdsByLoan = new Map<string, Map<number, number>>();
    for (const agg of byLoan.values()) {
      const loanKey = agg.loan_key;
      const sorted = [...agg.rows].sort(
        (a, b) => stmtSortKey(a.statement.close) - stmtSortKey(b.statement.close)
      );
      const first = sorted[0]!;
      let purchaseDate: string | null = null;
      for (const r of sorted) {
        const iso = r.line.transaction_date;
        if (iso && (!purchaseDate || iso < purchaseDate)) purchaseDate = iso;
      }
      if (!purchaseDate) purchaseDate = parseDdMmYyToIso(first.statement.close) ?? "2000-01-01";

      let maxTotal = 0;
      let maxCuotas = 0;
      for (const r of sorted) {
        if (isInstallmentContractSummaryMerchant(r.line.merchant)) continue;
        maxTotal = Math.max(maxTotal, installmentContractAmountClp(r));
        const nt = r.line.installment?.count ?? null;
        if (nt != null && nt > 0) maxCuotas = Math.max(maxCuotas, nt);
      }
      if (maxCuotas <= 0) continue;

      // Parser-provided baseline match (the Python parser matched it against the archived
      // installments CSV at parse time) — trusted as-is; runtime never re-reads cfraser CSVs.
      const matched = first.line.document.baseline_match ?? "";
      const matched_baseline = matched !== "" ? matched : null;

      const merchant = first.line.merchant || null;
      const fingerprint = installmentPurchaseLedgerDedupeKey({
        purchase_date: purchaseDate,
        total_amount_clp: maxTotal,
        cuotas_totales: maxCuotas,
        merchant,
        twin_index: agg.twin_index,
      });
      let pid = purchaseIdByFingerprint.get(fingerprint);
      if (pid == null) {
        insP.run({
          account_id: accountId,
          card_group: agg.card_group,
          canonical_row_id: agg.canonical_row_id,
          dedupe_key: first.line.document.dedupe_key || loanKey,
          parser_row_id_sample: first.line.document.line_id,
          source_pdf_sample: first.statement.document.trim() || null,
          purchase_date: purchaseDate,
          total_amount_clp: maxTotal,
          cuotas_totales: maxCuotas,
          merchant,
          description_merged: first.line.description,
          matched_baseline_purchase_id: matched_baseline,
          twin_index: agg.twin_index,
        });
        purchaseUpserts++;
        // A contract added now consumes cupo on its OWN purchase date (see the daily walk),
        // so it invalidates any frozen stamp written after that date.
        if (
          purchaseDate &&
          (earliestNewPurchaseDate == null || purchaseDate < earliestNewPurchaseDate)
        ) {
          earliestNewPurchaseDate = purchaseDate;
        }
        pid = (selId.get(accountId, agg.card_group, agg.canonical_row_id) as { id: number }).id;
        purchaseIdByFingerprint.set(fingerprint, pid);
      } else {
        db.prepare(
          `UPDATE cc_installment_purchases SET
             purchase_date = @purchase_date,
             total_amount_clp = @total_amount_clp,
             cuotas_totales = @cuotas_totales,
             merchant = COALESCE(NULLIF(merchant, ''), @merchant),
             description_merged = COALESCE(NULLIF(description_merged, ''), @description_merged),
             dedupe_key = COALESCE(@dedupe_key, dedupe_key),
             parser_row_id_sample = COALESCE(@parser_row_id_sample, parser_row_id_sample),
             source_pdf_sample = COALESCE(@source_pdf_sample, source_pdf_sample),
             matched_baseline_purchase_id = COALESCE(@matched_baseline_purchase_id, matched_baseline_purchase_id)
           WHERE id = @id`
        ).run({
          id: pid,
          purchase_date: purchaseDate,
          total_amount_clp: maxTotal,
          cuotas_totales: maxCuotas,
          merchant,
          description_merged: first.line.description,
          dedupe_key: first.line.document.dedupe_key || loanKey,
          parser_row_id_sample: first.line.document.line_id,
          source_pdf_sample: first.statement.document.trim() || null,
          matched_baseline_purchase_id: matched_baseline,
        });
        purchaseUpserts++;
      }
      touchedPlanIds.add(pid);
      const planIdByTwin = planIdsByLoan.get(loanKey) ?? new Map<number, number>();
      planIdByTwin.set(agg.twin_index, pid);
      planIdsByLoan.set(loanKey, planIdByTwin);

      const payGroups = new Map<string, CardStatementLineRef[]>();
      for (const r of sorted) {
        const pk = `${r.statement.document}\t${r.statement.close}`;
        const list = payGroups.get(pk) ?? [];
        list.push(r);
        payGroups.set(pk, list);
      }

      const payByRule = () => ccDerivedPayByRuleForAccount(accountId);
      for (const list of payGroups.values()) {
        const chosen = [...list].sort((a, b) => {
          const da = a.line.document.duplicate_across_statements;
          const dbi = b.line.document.duplicate_across_statements;
          if (da !== dbi) return da ? 1 : -1;
          return String(a.line.document.line_id ?? "").localeCompare(String(b.line.document.line_id ?? ""));
        })[0]!;
        const { statement, line } = chosen;
        const inst = line.installment!;

        const payBy = resolveInstallmentPayByIso(
          {
            pay_by: statement.pay_by ?? undefined,
            statement_date: statement.close,
            period_to: statement.period_to ?? undefined,
            transaction_date: storedCardLineDate(line.printed_transaction_date, line.transaction_date) ?? undefined,
          },
          payByRule
        );
        if (!payBy) continue;
        const cuotaAmt = inst.cuota_amount;
        if (cuotaAmt == null || cuotaAmt <= 0) continue;
        // A «00/N» row (bought this cycle, nothing billed yet) is stored with no cuota number: the
        // PDF parse leaves the cell empty, the statement JSON writes 0. Stored as 0 it read as
        // cuota 1 billed (`ledgerInstallmentsPaid` matched it by amount; 2026-10-28, plan 173).
        const cuota_current = inst.number === 0 ? null : inst.number;
        const ct = inst.count;
        const cuota_total = ct != null && ct > 0 ? ct : maxCuotas;

        insPay.run({
          purchase_id: pid,
          pay_by_date: payBy,
          statement_date: statement.close.trim() || null,
          statement_period_month: billingMonthForCcStatement({ statement_date: statement.close, period_to: statement.period_to }),
          source_pdf: statement.document.trim() || null,
          amount_clp: cuotaAmt,
          cuota_current,
          cuota_total,
          parser_row_id: line.document.line_id,
        });
        paymentUpserts++;
      }
    }
    assertTwinPlansStartTogether(accountId, planIdsByLoan);
  });

  run();

  // The gap fill is the plans this merge wrote (created, or their cuotas re-read): a plan no
  // statement of this import touched keeps the payments it has.
  const gapFilled = backfillMissingInstallmentPaymentsForPlans([...touchedPlanIds]).inserted;
  applyCardLinePlan(accountId, planOneShotLinesSupersededByInstallmentPurchases(accountId));
  // The contract consumes cupo on its purchase date: the stamps written after it are stale.
  noteCardLineEvidence(accountId, earliestNewPurchaseDate);

  return {
    purchaseUpserts,
    paymentUpserts,
    earliestNewPurchaseDate,
    gapFilled,
  };
};

export type CcAccountImportMergeResult = {
  statements: ReturnType<typeof importCcStatementsMerge>;
  ledger: CcInstallmentLedgerMergeResult;
  overlap_removed: number;
  manual_installment_reconcile: ReturnType<typeof reconcileManualInstallmentPurchasesAfterStatementImport>;
  web_paste_repair: ReturnType<typeof repairMisplacedOpenWebPasteBuckets>;
  web_paste_pdf_reconcile: CcOpenWebPastePdfReconcileResult[];
  /** PDF records dropped because the JSON importer owns their (close, currency) — the PDF is
   * the archive/cross-check there, never a second writer. */
  /** (close, currency) pairs where an incoming PDF replaced the JSON-written statement. */
  json_closes_superseded_by_pdf: string[];
  /** Grocery receipts flagged `pending_branch` on this card that the lines just written paired with. */
  grocery_branch_learning: GroceryBranchLearningResult;
  /** Categories, big groups, notes and splits carried from replaced lines onto their new rows. */
  expense_line_rekey: ReimportedCardLinesResult;
  /** The bucket passes every import runs once its lines are on file. */
  bucket: CcBucketPassesResult;
};

export type CcBucketPassesResult = {
  /** `shorter → fuller` pairs whose cut / pending re-listing was removed. */
  truncated_merchant_dedupe: string[];
  planted_payments: PlantedPaymentMatchResult;
  recurring_pending: RecurringPendingResult;
};

/**
 * The bucket passes, after every import's lines are on file (a statement's too): the shorter
 * re-listing of a purchase the bucket also holds in full (`ccTruncatedMerchantDedupe.ts`), a planted
 * payment the bank's own line now lists (`ccPlantedPayments.ts`; only a listing import carries the
 * bank's line), an automatic payment's pending listing its posted line replaces
 * (`ccRecurringPendingLines.ts`). Each planner plans; the funnel's step applies.
 */
function runBucketPasses(
  accountId: number,
  statements: readonly CardCanonicalStatement[],
  listingBatchKind: string | null
): CcBucketPassesResult {
  const truncated = planTruncatedMerchantDuplicateRemoval(accountId);
  applyCardLinePlan(accountId, truncated);
  const planted = listingBatchKind
    ? replacePlantedPaymentLinesFromImport(accountId, statements, listingBatchKind)
    : { result: { replaced: [], confirmed_in_place: [], ambiguous: [], removed_from_date: null }, plan: { deleteLineIds: [], carry: [] } };
  applyCardLinePlan(accountId, planted.plan);
  const recurring = planRecurringPendingReplacement(accountId);
  applyCardLinePlan(accountId, recurring.plan);
  return {
    truncated_merchant_dedupe: truncated.removed_pairs,
    planted_payments: planted.result,
    recurring_pending: recurring.result,
  };
}

/** Merge statements + installment ledger + billing (HTTP imports). */
/** Earliest of the given ISO dates (nulls ignored); null when none is set. */
function earliestIso(...dates: (string | null | undefined)[]): string | null {
  let out: string | null = null;
  for (const d of dates) {
    if (!d) continue;
    if (out == null || d < out) out = d;
  }
  return out;
}

export function mergeCardStatements(
  accountId: number,
  statements: readonly CardCanonicalStatement[],
  opts?: {
    statements?: CcStatementsMergeOpts;
    replaceLedger?: boolean;
    replaceStatementKeys?: Set<string>;
    /** A listing import (paste, feed, planted line): its batch kind, for the planted-payment pass. */
    listingBatchKind?: string;
  }
): CcAccountImportMergeResult {
  return withCardLineSession(accountId, "this statement import", () => mergeInSession(accountId, statements, opts));
}

function mergeInSession(
  accountId: number,
  statements: readonly CardCanonicalStatement[],
  opts?: {
    statements?: CcStatementsMergeOpts;
    replaceLedger?: boolean;
    replaceStatementKeys?: Set<string>;
    listingBatchKind?: string;
  }
): CcAccountImportMergeResult {
  const replaceKeys = opts?.replaceStatementKeys;

  // **The PDF outranks the JSON** (2026-08-06). The JSON importer is the fast first writer — it
  // can publish a facturación the day it closes — but it is not the authoritative document: the
  // international endpoint is dateless and serves all-NULL headers, so a JSON USD statement
  // carries lines only. The real statement PDF now arrives by e-mail a day or two later, and when
  // it does it TAKES OVER its (close, currency): the JSON rows are deleted and the PDF is written
  // in their place. Previously the PDF was dropped here, which under mail delivery would have
  // meant the richer document never reached the ledger at all.
  //
  // Two things make the takeover safe: the JSON statement keys go into `replaceStatementKeys`, so
  // the reconcile does not count their lines against the incoming PDF (otherwise every superseded
  // close would double and throw), and the delete runs inside the same transaction as the write.
  // Web-paste and JSON-source records pass through untouched.
  const jsonOwned = jsonOwnedClosesForAccount(accountId);
  const json_closes_superseded_by_pdf: string[] = [];
  const supersededJsonStatementIds: number[] = [];
  const supersededReplaceKeys = new Set<string>();
  if (jsonOwned.size > 0) {
    const incomingPdfCloses = new Set<string>();
    for (const statement of statements) {
      const kind = ccStatementSourceKindOf(statement.document);
      const isRealPdf = kind === "statement_pdf" || kind === "statement_other";
      if (!isRealPdf) continue;
      const closeKey = `${padCcStatementDate(statement.close)}\t${statement.currency}`;
      if (jsonOwned.has(closeKey)) incomingPdfCloses.add(closeKey);
    }
    if (incomingPdfCloses.size > 0) {
      for (const st of listJsonOwnedStatementsForAccount(accountId)) {
        const closeKey = `${padCcStatementDate(st.statement_date)}\t${st.currency}`;
        if (!incomingPdfCloses.has(closeKey)) continue;
        supersededJsonStatementIds.push(st.id);
        supersededReplaceKeys.add(statementReplaceKey(st));
        json_closes_superseded_by_pdf.push(closeKey.replace("\t", " "));
      }
      json_closes_superseded_by_pdf.sort();
    }
  }
  // Only widen the caller's set when there is something to supersede, so a caller that passed
  // `undefined` keeps passing `undefined` in the ordinary case.
  const effectiveReplaceKeys =
    supersededReplaceKeys.size > 0
      ? new Set<string>([...(replaceKeys ?? []), ...supersededReplaceKeys])
      : replaceKeys;

  // Validate before writing anything — throws if reconcile pre-checks fail.
  assertCcImportReconcilesOrThrow(accountId, statements, {
    replaceStatementKeys: effectiveReplaceKeys,
  });

  // All writes in the card-line write's one transaction, so a mid-merge error (e.g. missing
  // import) leaves no partial state and a retry is a true no-op. The write's frame checks that the
  // converted card payments whose evidence was on file still find it — replaced lines, a superseded
  // JSON close and settled bucket lines all get new rows.
  // Before any line is replaced: the purchase assignments keyed by the old rows follow them
  // onto the new ones at the end (`flows/cardLineAdoption.ts`).
  const expenseLines = captureCardLines(accountId);
  // Inside the transaction: the JSON rows a PDF is taking over go first, so the write below
  // lands on a close with no competing statement row (lines cascade via the FK).
  deleteJsonStatementsByIds(supersededJsonStatementIds);
  const statementsResult = importCcStatementsMerge(accountId, statements, {
    replaceAll: false,
    replaceStatementKeys: effectiveReplaceKeys,
    skipGlobalDedupeKeys: true,
    ...opts?.statements,
  });
  // A statement for a close the card feed already observed must bill exactly the feed's
  // SALDO INICIAL on the same date — two independent renderings of one number. Throws inside
  // the transaction, so a disagreeing import writes nothing.
  assertFeedClosesMatchStatements(accountId);
  const ledger = mergeInstallmentLedgerFromStatements(accountId, statements, {
    replaceLedger: opts?.replaceLedger ?? false,
  });
  const manual_installment_reconcile = reconcileManualInstallmentPurchasesAfterStatementImport(accountId, statements);
  const overlap = planOneShotLinesSupersededByInstallmentPurchases(accountId);
  applyCardLinePlan(accountId, overlap);
  const web_paste_repair = repairMisplacedOpenWebPasteBuckets(accountId);
  const web_paste_pdf_reconcile = reconcileOpenWebPasteAfterPdfImports(accountId, statements);
  // Statement replacement above cascaded any existing traspaso links away; rebuild them
  // from the final line set (throws on an unpairable leg, aborting the whole merge).
  relinkCcTraspasoDeudaLinksForAccount(accountId);
  // A grocery receipt paid with this card at a branch no map names waits, flagged, for the
  // bank's own line for its day and pesos — which this write may have just landed, from
  // whichever source (paste textarea, nightly feed, statement PDF). Pairing it here teaches
  // the branch's merchant string, so the next receipt at that store writes its own line.
  const grocery_branch_learning = learnGroceryBranchesFromCardLines(accountId);
  const expense_line_rekey = adoptReimportedCardLines(expenseLines);
  const bucket = runBucketPasses(accountId, statements, opts?.listingBatchKind ?? null);
  // Whatever this import added for past days invalidates the frozen daily stamps written after
  // it — a paste of last week's purchases must show up on those days, not as today's move; bucket
  // lines the statement settled are evidence removed on their own dates.
  noteCardLineEvidence(
    accountId,
    earliestIso(
      statementsResult.earliestInsertedTxDate,
      ledger.earliestNewPurchaseDate,
      ...web_paste_pdf_reconcile.map((r) => r.earliest_deleted_iso)
    )
  );
  // This write may have landed the cuota purchase that paid another card's facturado (the feed's
  // plan, a statement's), or the statement that facturado closed on.
  noteCardLineFinancingLinks(accountId);
  return {
    statements: statementsResult,
    ledger,
    overlap_removed: overlap.removed_line_ids.length,
    manual_installment_reconcile,
    web_paste_repair,
    web_paste_pdf_reconcile,
    json_closes_superseded_by_pdf,
    grocery_branch_learning,
    expense_line_rekey,
    bucket,
  };
}

/** The ledger statement keys a set of statements names (`card_group\tsource_pdf\tstatement_date`). */
export function statementKeysOf(statements: readonly CardCanonicalStatement[]): Set<string> {
  return new Set(statements.map(cardStatementKey));
}
