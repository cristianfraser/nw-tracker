import type { ListingOrder } from "nw-tracker-contracts";
import { ccCardGroupOrDefault } from "./ccIssuers.js";
import { compareArrival, flowArrival, recordPlanFlowFirstSeen, setFlowArrival } from "./flows/flowFirstSeen.js";
import { flowHoldsAssignments } from "./flows/mirrorLegFlows.js";
import { db } from "./db.js";
import { ccStatementSourceKindOf } from "./ccStatementSourceKind.js";
import {
  applyCardLinePlan,
  applyCardLinePlanDetailed,
  foldSiblingPlanFlow,
  handOverPlanRecords,
  planOneShotLinesSupersededByInstallmentPurchases,
  type CardLinePiecesDropped,
} from "./ccCrossImportDedupe.js";
import {
  isInstallmentContractSummaryMerchant,
  merchantStemForInstallmentDedupe,
} from "./ccInstallmentLineDedupe.js";
import { backfillMissingInstallmentPaymentsForPlans } from "./ccInstallmentPaymentBackfill.js";
import { resolveInstallmentPayByIso } from "./ccInstallmentPayBy.js";
import { ccDerivedPayByRuleForAccount } from "./ccIssuerForAccount.js";
import { importCcStatementsMerge } from "./ccStatementsImport.js";
import { storedCardLineAmounts } from "./cards/statementStorage.js";
import { reconcileManualInstallmentPurchasesAfterStatementImport } from "./ccManualInstallmentStatementReconcile.js";
import { assertFeedClosesMatchStatements } from "./ccBillingCloses.js";
import { assertOneStatementPerFacturacion } from "./cards/facturacion.js";
import { listCcStatementsForAccount } from "./ccStatementsDb.js";
import { repairMisplacedOpenWebPasteBuckets } from "./ccOpenWebPasteRepair.js";
import {
  jsonOwnedClosesForAccount,
  listJsonOwnedStatementsForAccount,
  statementReplaceKey,
  padCcStatementDate,
} from "./ccStatementJsonSource.js";
import { learnGroceryBranchesFromCardLines, type GroceryBranchLearningResult } from "./groceryBranchLearning.js";
import { relinkCcTraspasoDeudaLinksForAccount } from "./ccTraspasoDeudaLinks.js";
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

/**
 * The plan a loan chain is (pure): its rows oldest statement first, the earliest purchase day on
 * them (else the first statement's close), the largest principal and cuota count (contract-summary
 * rows aside), the first row's merchant. Null when no row states a cuota count.
 */
export function loanChainPlanFacts(chain: CcInstallmentLoanChain): {
  sorted: CardStatementLineRef[];
  first: CardStatementLineRef;
  purchase_date: string;
  total_amount_clp: number;
  cuotas_totales: number;
  merchant: string | null;
  twin_index: number;
} | null {
  const sorted = [...chain.rows].sort((a, b) => stmtSortKey(a.statement.close) - stmtSortKey(b.statement.close));
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
  if (maxCuotas <= 0) return null;
  return {
    sorted,
    first,
    purchase_date: purchaseDate,
    total_amount_clp: maxTotal,
    cuotas_totales: maxCuotas,
    merchant: first.line.merchant || null,
    twin_index: chain.twin_index,
  };
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
  /** Pieces of one-shot lines this merge's plans replaced, dropped (a plan takes none). */
  pieces_dropped: CardLinePiecesDropped[];
  /**
   * A rebuild's stale plans that went with filed work (category, note, big group, pieces, links) and
   * no plan to take it over: the flow is retired, nothing reads it again.
   */
  stale_plans_retired_with_assignments: RetiredStalePlan[];
  /** A rebuild's earliest day of a plan removed or restated with another date or amounts (old and new); null otherwise. */
  earliestChangedEvidenceDate: string | null;
  /**
   * The plan each loan chain ended on, by the chain's own fingerprint (`loanChainPlanFacts` →
   * `installmentPurchaseLedgerDedupeKey`): the row an upsert kept may fingerprint differently (a
   * row on file under the chain's canonical row keeps its merchant, a manual one its total).
   */
  chain_plans: { fingerprint: string; plan_id: number }[];
};

export type RetiredStalePlan = { plan_id: number; merchant: string | null; purchase_date: string; total_amount_clp: number };

export type CcInstallmentLedgerMergeOpts = {
  /**
   * Rebuild the account's plan ledger from the statements (`import:cc-parsed --replace-ledger`):
   * the payments are re-read, a plan the statements still state stays the row it is (its id, flow,
   * arrival, prepayment and provenance rows), a statement plan with no row is written, and a
   * statement plan no statement states any more goes — refused when something names it by id
   * (a bank prepayment), its flow folded into the plan that replaces it — the same identity, else the
   * one new plan of the same loan key — and what it cannot hand over is reported. A rebuild never
   * stamps an arrival.
   */
  replaceLedger?: boolean;
};

type StalePlan = {
  id: number;
  purchase_date: string;
  total_amount_clp: number;
  cuotas_totales: number;
  merchant: string | null;
  twin_index: number;
};

/** The ISO day a `purchase_date` column value stands for (evidence dates are ISO days). */
const planDay = (d: string): string => d.slice(0, 10);

/**
 * What names a stale plan by its id where deleting it would lose the record: a bank prepayment.
 * (A card-to-card payment part is derived: its sync re-points it after the write. The feed's
 * provenance row belongs to hand-entered plans, which a rebuild never removes.)
 */
function planIdReferences(planId: number): string[] {
  return db.prepare(`SELECT 1 FROM cc_plan_prepayments WHERE purchase_id = ?`).get(planId) != null
    ? ["a bank prepayment (cc_plan_prepayments)"]
    : [];
}

/**
 * The tail of a ledger rebuild: the statement plans the statements no longer state go, each
 * handing what it can to the plan that replaces it. The replacement is the kept plan of the same
 * identity (`foldSiblingPlanFlow`, the older arrival kept) or, when the identity changed with the
 * parse, the one plan written new in this rebuild under the same `dedupe_key` (the loan key the
 * chains group by) when exactly one stale plan and one new plan share it. A stale plan's prepayment
 * goes with its flow. A stale plan with no replacement that is named by a prepayment makes the
 * rebuild refuse, listing it (nothing is written); one with filed work and no replacement is
 * reported. Returns those, and the earliest purchase day of the plans removed (their stamps).
 */
function removeStaleStatementPlans(
  accountId: number,
  touched: ReadonlySet<number>,
  created: ReadonlySet<number>
): { retired_with_assignments: RetiredStalePlan[]; earliest_removed_on: string | null } {
  const stale = (
    db
      .prepare(
        `SELECT id, purchase_date, total_amount_clp, cuotas_totales, merchant, twin_index, dedupe_key, flow_id
         FROM cc_installment_purchases WHERE account_id = ? AND source != 'manual' ORDER BY id`
      )
      .all(accountId) as (StalePlan & { dedupe_key: string | null; flow_id: number | null })[]
  ).filter((p) => !touched.has(p.id));
  if (stale.length === 0) return { retired_with_assignments: [], earliest_removed_on: null };

  const sel = db.prepare(
    `SELECT id, purchase_date, total_amount_clp, cuotas_totales, merchant, twin_index, dedupe_key
     FROM cc_installment_purchases WHERE id = ?`
  );
  const keptByIdentity = new Map<string, number>();
  for (const id of touched) {
    const row = sel.get(id) as StalePlan | undefined;
    if (row) keptByIdentity.set(installmentPurchaseLedgerDedupeKey(row), row.id);
  }
  // The loose pairing: one stale plan and one plan written new share a loan key.
  const createdByKey = new Map<string, number[]>();
  for (const id of created) {
    const key = (sel.get(id) as { dedupe_key: string | null } | undefined)?.dedupe_key;
    if (key) createdByKey.set(key, [...(createdByKey.get(key) ?? []), id]);
  }
  const staleByKey = new Map<string, number>();
  for (const p of stale) if (p.dedupe_key) staleByKey.set(p.dedupe_key, (staleByKey.get(p.dedupe_key) ?? 0) + 1);
  const replacementOf = (p: (typeof stale)[number]): number | null => {
    const same = keptByIdentity.get(installmentPurchaseLedgerDedupeKey(p));
    if (same != null) return same;
    const candidates = p.dedupe_key ? createdByKey.get(p.dedupe_key) ?? [] : [];
    return candidates.length === 1 && staleByKey.get(p.dedupe_key!) === 1 ? candidates[0]! : null;
  };

  const plans = stale.map((p) => ({ p, replacement: replacementOf(p) }));
  const unreplaced = plans.filter((x) => x.replacement == null);
  const referenced = unreplaced.map((x) => ({ p: x.p, refs: planIdReferences(x.p.id) })).filter((x) => x.refs.length > 0);
  if (referenced.length > 0) {
    throw new Error(
      `ledger rebuild refused for account ${accountId}: ${referenced.length} plan(s) the statements no longer state carry a record that names them by id — ` +
        referenced.map((x) => `plan ${x.p.id} («${x.p.merchant ?? "?"}», ${x.p.purchase_date}, ${x.p.total_amount_clp}): ${x.refs.join(", ")}`).join("; ") +
        `. If the statements are right and the plan is gone, delete its prepayment record ` +
        `(DELETE FROM cc_plan_prepayments WHERE purchase_id = <plan id>) and run again; if the parse lost the plan, fix the parse first. Nothing was written.`
    );
  }
  const retired: RetiredStalePlan[] = [];
  let earliest: string | null = null;
  for (const { p, replacement } of plans) {
    const day = planDay(p.purchase_date);
    if (earliest == null || day < earliest) earliest = day;
    if (replacement != null) {
      // The replaced plan's arrival stays whatever the fold's rule says of a freshly written one.
      const arrival = p.flow_id != null ? flowArrival(p.flow_id) : ({ kind: "not_an_arrival" } as const);
      handOverPlanRecords(accountId, replacement, p.id);
      foldSiblingPlanFlow(accountId, replacement, p.id);
      const flow = (db.prepare(`SELECT flow_id FROM cc_installment_purchases WHERE id = ?`).get(replacement) as { flow_id: number }).flow_id;
      const now = flowArrival(flow);
      if (arrival.kind === "stamped" && (now.kind !== "stamped" || compareArrival(arrival, now) < 0)) setFlowArrival(flow, arrival);
    } else if (p.flow_id != null && flowHoldsAssignments(p.flow_id, db)) {
      retired.push({ plan_id: p.id, merchant: p.merchant, purchase_date: p.purchase_date, total_amount_clp: p.total_amount_clp });
    }
    db.prepare(`DELETE FROM cc_installment_purchases WHERE id = ?`).run(p.id);
  }
  return { retired_with_assignments: retired, earliest_removed_on: earliest };
}

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
  const chainPlans: { fingerprint: string; plan_id: number }[] = [];
  let earliestNewPurchaseDate: string | null = null;
  let paymentUpserts = 0;
  const touchedPlanIds = new Set<number>();
  const createdPlanIds = new Set<number>();
  // A rebuild's other changes to what the card owes: days of plans whose date or amounts changed
  // (old and new) and of plans removed. Their today-stamps are stale like a new plan's.
  let earliestChangedOn: string | null = null;
  const noteChangedDay = (d: string | null | undefined) => {
    if (!d) return;
    const day = planDay(d);
    if (earliestChangedOn == null || day < earliestChangedOn) earliestChangedOn = day;
  };
  let retiredStale: RetiredStalePlan[] = [];
  const selPlanFacts = db.prepare(`SELECT purchase_date, total_amount_clp, cuotas_totales FROM cc_installment_purchases WHERE id = ?`);
  /** A plan on file the rebuild restates: when its date or amounts change, both days are evidence. */
  const noteChangedRow = (row: { id: number }, date: string, total: number, cuotas: number) => {
    const old = selPlanFacts.get(row.id) as { purchase_date: string; total_amount_clp: number; cuotas_totales: number };
    if (old.purchase_date === date && old.total_amount_clp === total && old.cuotas_totales === cuotas) return;
    noteChangedDay(old.purchase_date);
    noteChangedDay(date);
  };

  const run = db.transaction(() => {
    if (replaceLedger) {
      db.prepare(
        `DELETE FROM cc_installment_payments WHERE purchase_id IN (SELECT id FROM cc_installment_purchases WHERE account_id = ?)`
      ).run(accountId);
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
      const facts = loanChainPlanFacts(agg);
      if (!facts) continue;
      const { sorted, first, purchase_date: purchaseDate, total_amount_clp: maxTotal, cuotas_totales: maxCuotas } = facts;

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
        const onFile = selId.get(accountId, agg.card_group, agg.canonical_row_id) != null;
        if (replaceLedger && onFile) noteChangedRow(selId.get(accountId, agg.card_group, agg.canonical_row_id) as { id: number }, purchaseDate, maxTotal, maxCuotas);
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
        // A plan written new is the purchase's arrival (its cuota lines are not: `FlowArrival`).
        // A rebuild re-creates what was on file: it stamps nothing.
        if (!onFile && !replaceLedger) recordPlanFlowFirstSeen(pid);
        if (!onFile) createdPlanIds.add(pid);
      } else {
        if (replaceLedger) noteChangedRow({ id: pid }, purchaseDate, maxTotal, maxCuotas);
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
      chainPlans.push({ fingerprint, plan_id: pid });
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
    if (replaceLedger) {
      const removed = removeStaleStatementPlans(accountId, touchedPlanIds, createdPlanIds);
      retiredStale = removed.retired_with_assignments;
      noteChangedDay(removed.earliest_removed_on);
    }
  });

  run();

  // The gap fill is the plans this merge wrote (created, or their cuotas re-read): a plan no
  // statement of this import touched keeps the payments it has.
  const gapFilled = backfillMissingInstallmentPaymentsForPlans([...touchedPlanIds]).inserted;
  const { pieces_dropped } = applyCardLinePlanDetailed(accountId, planOneShotLinesSupersededByInstallmentPurchases(accountId));
  // The contract consumes cupo on its purchase date: the stamps written after it are stale.
  noteCardLineEvidence(accountId, earliestNewPurchaseDate);
  noteCardLineEvidence(accountId, earliestChangedOn);

  return {
    purchaseUpserts,
    paymentUpserts,
    earliestNewPurchaseDate,
    gapFilled,
    pieces_dropped,
    stale_plans_retired_with_assignments: retiredStale,
    earliestChangedEvidenceDate: earliestChangedOn,
    chain_plans: chainPlans,
  };
};

export type CcAccountImportMergeResult = {
  statements: ReturnType<typeof importCcStatementsMerge>;
  ledger: CcInstallmentLedgerMergeResult;
  overlap_removed: number;
  /** Pieces of one-shot lines a plan replaced, dropped (the ledger's own pass and the overlap pass). */
  pieces_dropped: CardLinePiecesDropped[];
  manual_installment_reconcile: ReturnType<typeof reconcileManualInstallmentPurchasesAfterStatementImport>;
  web_paste_repair: ReturnType<typeof repairMisplacedOpenWebPasteBuckets>;
  /** Grocery receipts flagged `pending_branch` on this card that the lines just written paired with. */
  grocery_branch_learning: GroceryBranchLearningResult;
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
export function runBucketPasses(
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

/**
 * The JSON-written statements an incoming PDF takes over (same close and currency): their ids, the
 * replace keys that keep the reconcile from counting their lines, and the closes, for the report.
 */
export function jsonStatementsSupersededByPdf(
  accountId: number,
  statements: readonly CardCanonicalStatement[]
): { json_closes_superseded_by_pdf: string[]; supersededJsonStatementIds: number[]; supersededReplaceKeys: Set<string> } {
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
  return { json_closes_superseded_by_pdf, supersededJsonStatementIds, supersededReplaceKeys };
}

/**
 * A listing's lines (paste, feed, planted line, a receipt's line) into the card's open buckets, then
 * the plan ledger, the bucket repair and the bucket passes, as one card-line write. A listing never
 * replaces a line on file: a line it lists again is a duplicate it skips, and a line its passes
 * remove names the line that replaces it (`CardLinePlan.carry`). Statements import as a plan applied
 * (`importStatementDocuments`).
 */
export function mergeListingStatements(
  accountId: number,
  statements: readonly CardCanonicalStatement[],
  opts: {
    /** The listing's batch kind (the planted charges and payments). */
    listingBatchKind: string;
    /** The order it prints its lines in (`listingOrder.ts`). */
    listingOrder?: ListingOrder;
  }
): CcAccountImportMergeResult {
  return withCardLineSession(accountId, "this listing import", () => mergeInSession(accountId, statements, opts));
}

function mergeInSession(
  accountId: number,
  statements: readonly CardCanonicalStatement[],
  opts: { listingBatchKind: string; listingOrder?: ListingOrder }
): CcAccountImportMergeResult {
  // All writes in the card-line write's one transaction, so a mid-merge error leaves no partial
  // state and a retry is a true no-op.
  const statementsResult = importCcStatementsMerge(accountId, statements, {
    listingBatchKind: opts.listingBatchKind,
    ...(opts.listingOrder ? { listingOrder: opts.listingOrder } : {}),
  });
  // A statement for a close the card feed already observed must bill exactly the feed's
  // SALDO INICIAL on the same date. Throws inside the transaction, so a disagreeing import writes nothing.
  assertFeedClosesMatchStatements(accountId);
  // Two different statements of one currency closing in one billing month would merge into one
  // facturación (one close dropped). Throws inside the transaction, so nothing is written.
  assertOneStatementPerFacturacion(listCcStatementsForAccount(accountId), `Account ${accountId}`);
  const ledger = mergeInstallmentLedgerFromStatements(accountId, statements, { replaceLedger: false });
  const manual_installment_reconcile = reconcileManualInstallmentPurchasesAfterStatementImport(accountId, statements);
  const overlap = planOneShotLinesSupersededByInstallmentPurchases(accountId);
  const overlapApplied = applyCardLinePlanDetailed(accountId, overlap);
  const web_paste_repair = repairMisplacedOpenWebPasteBuckets(accountId);
  relinkCcTraspasoDeudaLinksForAccount(accountId);
  // A grocery receipt paid with this card at a branch no map names waits, flagged, for the
  // bank's own line for its day and pesos — which this write may have just landed. Pairing it here
  // teaches the branch's merchant string, so the next receipt at that store writes its own line.
  const grocery_branch_learning = learnGroceryBranchesFromCardLines(accountId);
  const bucket = runBucketPasses(accountId, statements, opts.listingBatchKind);
  // Whatever this import added for past days invalidates the frozen daily stamps written after
  // it — a paste of last week's purchases must show up on those days, not as today's move.
  noteCardLineEvidence(accountId, earliestIso(statementsResult.earliestInsertedTxDate, ledger.earliestNewPurchaseDate));
  // This write may have landed the cuota purchase that paid another card's facturado.
  noteCardLineFinancingLinks(accountId);
  return {
    statements: statementsResult,
    ledger,
    overlap_removed: overlap.removed_line_ids.length,
    pieces_dropped: [...ledger.pieces_dropped, ...overlapApplied.pieces_dropped],
    manual_installment_reconcile,
    web_paste_repair,
    grocery_branch_learning,
    bucket,
  };
}

/** The ledger statement keys a set of statements names (`card_group\tsource_pdf\tstatement_date`). */
export function statementKeysOf(statements: readonly CardCanonicalStatement[]): Set<string> {
  return new Set(statements.map(cardStatementKey));
}
