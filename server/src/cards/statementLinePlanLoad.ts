/**
 * Reads what the statement-line planner (`statementLinePlan.ts`) needs for one statement import,
 * from the ledger as it stands. Writes nothing: the facts that depend on the incoming headers (the
 * facturaciones they close, the next cycle's first day, the open month, where the bucket repair
 * moves a line) are read with the headers written inside a savepoint that is rolled back — or, when
 * every header is on file exactly as the import would write it and no JSON close is taken over
 * ({@link cardStatementHeadersOnFile}), straight from the ledger, touching nothing at all.
 */
import type { CardCanonicalStatement } from "nw-tracker-contracts";
import { db } from "../db.js";
import { ccStatementSourceKindOf, isListingSourceKind } from "../ccStatementSourceKind.js";
import { listCcStatementLinesForStatement, listCcStatementsForAccount, type CcStatementRow } from "../ccStatementsDb.js";
import { resolveCcStatementHeader, statementsByLedgerKey, upsertCcStatementHeader } from "../ccStatementsImport.js";
import { deleteJsonStatementsByIds } from "../ccStatementJsonSource.js";
import {
  groupInstallmentLoanChains,
  jsonStatementsSupersededByPdf,
  loanChainPlanFacts,
} from "../ccInstallmentLedgerMerge.js";
import { canonicalLineDedupeKeys, storedCardLineAmounts, storedLineColumns } from "./statementStorage.js";
import { ccCardGroupOrDefault } from "../ccIssuers.js";
import {
  dedupeInstallmentPurchaseLedgerRows,
  installmentPurchaseLedgerDedupeKey,
  listOneShotLinesForAccount,
  listPlansForLineMatching,
  withTakenRenderings,
  type CardPlanForMatching,
} from "./purchases.js";
import { sourceLinesOfPlans } from "../ccCrossImportDedupe.js";
import { listAnnulledPurchases } from "../ccAnnulledPurchases.js";
import { listPlantedPaymentLines } from "../ccPlantedPayments.js";
import { planPrepaymentRows } from "../ccPlanPrepaymentsRead.js";
import { flowArrival, type FlowArrival } from "../flows/flowFirstSeen.js";
import { cardLineAssignmentSignature, ccLineRefFromRow, CC_LINE_REF_SELECT } from "../flows/cardLineAdoption.js";
import {
  closedPeriodIsoRange,
  pdfClosedBillingMonthsFromImport,
  type PlanPrepaymentLineRole,
} from "../ccOpenWebPastePdfReconcile.js";
import { hasEveryStatementTwinForBillingMonth, statementSlotsByBillingMonth } from "../ccBillingStatementSlots.js";
import {
  billingMonthForManualLedgerPurchase,
  nextPeriodStartIsoForBillingMonth,
  requiredStatementCurrenciesForAccount,
  targetBillingMonthForManualImports,
} from "./facturacion.js";
import { misplacedBucketLineTarget, openWebPasteSourcePdf, parseOpenWebPasteBillingMonth } from "../ccOpenWebPasteRepair.js";
import { creditCardMasterMetaForAccount } from "../ccWebPasteParse.js";
import { cardLineAmountClpAtStoredRate } from "../ccExpenseAmountClp.js";
import { isStatementSourceKind } from "../ccStatementSourceKind.js";
import { parseDdMmYyToIso } from "nw-tracker-contracts";
import type {
  CardStatementLinePlanInput,
  PlanClosedMonth,
  PlanDocStatement,
  PlanFileLine,
  PlanStatement,
} from "./statementLinePlan.js";

type FileLineRow = {
  id: number;
  statement_id: number;
  transaction_date: string | null;
  posting_date: string | null;
  merchant: string | null;
  amount: number | null;
  currency: string;
  installment_flag: number;
  nro_cuota_current: number | null;
  nro_cuota_total: number | null;
  parser_row_id: string | null;
  dedupe_key: string | null;
  cuota_purchase_kind: string | null;
  flow_id: number | null;
  statement_date: string;
  statement_currency: string;
};

class RollBack extends Error {}

function arrivalOf(flowId: number | null): FlowArrival {
  return flowId == null ? { kind: "not_an_arrival" } : flowArrival(flowId);
}

function planStatementOf(st: CcStatementRow): PlanStatement {
  return {
    id: st.id,
    key: `${st.card_group}\t${st.source_pdf}\t${st.statement_date}`,
    source_kind: st.source_kind,
    currency: st.currency,
    bucket_billing_month: parseOpenWebPasteBillingMonth(st.source_pdf),
  };
}

/**
 * The planner's input for importing `statements` into the card `accountId` (the merge's options:
 * `replaceStatementKeys` replaces those statements' lines). A listing import is refused by the
 * planner, not here.
 */
export function loadCardStatementLinePlanInput(
  accountId: number,
  statements: readonly CardCanonicalStatement[],
  opts?: { replaceStatementKeys?: ReadonlySet<string> }
): CardStatementLinePlanInput {
  const byStmt = statementsByLedgerKey(statements);
  const json = jsonStatementsSupersededByPdf(accountId, statements);
  const replaceKeys = new Set<string>([...(opts?.replaceStatementKeys ?? []), ...json.supersededReplaceKeys]);
  const headersOnFile = json.supersededJsonStatementIds.length === 0 && cardStatementHeadersOnFile(accountId, statements);

  const rows = db
    .prepare(
      `SELECT l.id, l.statement_id, l.transaction_date, l.posting_date, l.merchant, l.amount, l.currency, l.installment_flag,
              l.nro_cuota_current, l.nro_cuota_total, l.parser_row_id, l.dedupe_key, l.cuota_purchase_kind, l.flow_id,
              s.statement_date, s.currency AS statement_currency
       FROM cc_statement_lines l JOIN cc_statements s ON s.id = l.statement_id
       WHERE s.account_id = ? ORDER BY l.id`
    )
    .all(accountId) as FileLineRow[];
  const planAmount = new Map(listOneShotLinesForAccount(accountId).map((l) => [l.statement_line_id, l.amount_clp]));
  const afterHeaders = readFactsAfterHeaders(accountId, statements, byStmt, json.supersededJsonStatementIds, replaceKeys, headersOnFile);
  const replacedStatementIds = afterHeaders.replacedStatementIds;
  const refRows = new Map(
    (db.prepare(`${CC_LINE_REF_SELECT} WHERE s.account_id = ?`).all(accountId) as Parameters<typeof ccLineRefFromRow>[0][]).map((r) => [
      r.id,
      r,
    ])
  );
  const file_lines: PlanFileLine[] = rows.map((r) => ({
    id: r.id,
    statement_id: r.statement_id,
    transaction_date: r.transaction_date,
    posting_date: r.posting_date,
    merchant: r.merchant,
    amount: r.amount,
    currency: r.currency,
    installment_flag: r.installment_flag === 1,
    nro_cuota_current: r.nro_cuota_current,
    nro_cuota_total: r.nro_cuota_total,
    parser_row_id: r.parser_row_id,
    dedupe_key: r.dedupe_key,
    cuota_purchase_kind: r.cuota_purchase_kind,
    statement_close: closeKey(r.statement_date, r.statement_currency),
    plan_match_amount_clp: planAmount.get(r.id) ?? null,
    arrival: arrivalOf(r.flow_id),
    // Only a replaced line can fan out (its signature decides it).
    assignment_signature: replacedStatementIds.has(r.statement_id)
      ? cardLineAssignmentSignature(ccLineRefFromRow(refRows.get(r.id)!))
      : null,
  }));

  const rawPlans = withTakenRenderings(
    accountId,
    db
      .prepare(
        `SELECT id, purchase_date, total_amount_clp, cuotas_totales, merchant, twin_index FROM cc_installment_purchases WHERE account_id = ?`
      )
      .all(accountId) as CardPlanForMatching[]
  );
  const fingerprints = new Set(rawPlans.map(installmentPurchaseLedgerDedupeKey));
  let nextPlanId = Math.max(0, ...rawPlans.map((p) => p.id)) + 1;
  const documentPlans: CardPlanForMatching[] = [];
  for (const chain of groupInstallmentLoanChains(statements).values()) {
    const facts = loanChainPlanFacts(chain);
    if (!facts) continue;
    const plan = {
      id: 0,
      purchase_date: facts.purchase_date,
      total_amount_clp: facts.total_amount_clp,
      cuotas_totales: facts.cuotas_totales,
      merchant: facts.merchant,
      twin_index: facts.twin_index,
    };
    const fp = installmentPurchaseLedgerDedupeKey(plan);
    if (fingerprints.has(fp)) continue;
    fingerprints.add(fp);
    documentPlans.push({ ...plan, id: nextPlanId++ });
  }

  const prepayment_roles: [number, PlanPrepaymentLineRole][] = [];
  for (const r of planPrepaymentRows(accountId)) {
    if (r.line_id != null) prepayment_roles.push([r.line_id, "prepayment"]);
    if (r.credit_line_id != null) prepayment_roles.push([r.credit_line_id, "credit"]);
  }

  const incoming: PlanDocStatement[] = [...byStmt].map(([key, { statement, lines }]) => {
    const close = closeKey(statement.close, statement.currency);
    const cardGroup = ccCardGroupOrDefault(statement.card_group);
    const statementIso = parseDdMmYyToIso(statement.close.trim());
    return {
      key,
      statement_id: afterHeaders.statementIdByKey.get(key)!,
      listing: isListingSourceKind(ccStatementSourceKindOf(statement.document)),
      currency: statement.currency,
      close,
      lines: lines.map((line) => {
        const columns = storedLineColumns(statement, line);
        const oneShotClp =
          line.installment == null
            ? cardLineAmountClpAtStoredRate({ installment_flag: 0, amount: line.amount, currency: line.currency, cuota_amount: null }, statementIso)
            : null;
        return {
          id: 0,
          transaction_date: columns.transaction_date,
          posting_date: columns.posting_date,
          merchant: columns.merchant,
          amount: line.amount,
          currency: line.currency,
          installment_flag: line.installment != null,
          nro_cuota_current: columns.nro_cuota_current,
          nro_cuota_total: columns.nro_cuota_total,
          parser_row_id: columns.parser_row_id,
          plan_match_amount_clp: oneShotClp != null && oneShotClp > 0 ? oneShotClp : null,
          raw_dedupe_keys: canonicalLineDedupeKeys(cardGroup, line),
          amount_clp: storedCardLineAmounts(line).amount_clp,
          date_iso: line.transaction_date ?? line.posting_date ?? null,
        };
      }),
    };
  });

  return {
    account_id: accountId,
    headers_on_file: headersOnFile,
    document_plans_new: documentPlans.length,
    statements: afterHeaders.statements,
    json_superseded_statement_ids: [...json.supersededJsonStatementIds],
    replaced_statement_ids: [...replacedStatementIds].filter((id) => !json.supersededJsonStatementIds.includes(id)),
    file_lines,
    bucket_repair_moves: afterHeaders.bucketRepairMoves,
    incoming,
    plans_before: listPlansForLineMatching(accountId),
    plans_after: dedupeInstallmentPurchaseLedgerRows([...rawPlans, ...documentPlans]),
    plan_source_lines: [...sourceLinesOfPlans(accountId)],
    closed_months: afterHeaders.closedMonths,
    open_billing_month: afterHeaders.openBillingMonth,
    annulments: listAnnulledPurchases(accountId).map((a) => ({ ...a, arrival: arrivalOf(a.flow_id) })),
    planted_payments: listPlantedPaymentLines(accountId),
    prepayment_roles,
  };
}

/** A statement's close as a takeover compares it: its ISO close day and its currency. */
function closeKey(statementDate: string, currency: string): string {
  return `${parseDdMmYyToIso(statementDate.trim()) ?? statementDate.trim()}\t${currency}`;
}

/**
 * Whether every statement of the import has its header on file exactly as the import would write it
 * (`resolveCcStatementHeader`: same row, same columns, same fingerprint). Read only.
 */
export function cardStatementHeadersOnFile(accountId: number, statements: readonly CardCanonicalStatement[]): boolean {
  const byStmt = statementsByLedgerKey(statements);
  if (byStmt.size === 0) return false;
  for (const { statement, lines } of byStmt.values()) {
    const r = resolveCcStatementHeader(accountId, statement, lines);
    if (r.statementId == null || !r.unchanged) return false;
  }
  return true;
}

/**
 * The facts that depend on the incoming headers, read with them written in a rolled-back savepoint;
 * `headersOnFile`: they are on file as the import would write them, read as they stand.
 */
function readFactsAfterHeaders(
  accountId: number,
  statements: readonly CardCanonicalStatement[],
  byStmt: ReturnType<typeof statementsByLedgerKey>,
  supersededJsonStatementIds: readonly number[],
  replaceKeys: ReadonlySet<string>,
  headersOnFile: boolean
): {
  statementIdByKey: Map<string, number>;
  /** Statements whose lines the import deletes first: a superseded JSON close, a statement it replaces. */
  replacedStatementIds: Set<number>;
  statements: PlanStatement[];
  closedMonths: PlanClosedMonth[];
  openBillingMonth: string | null;
  bucketRepairMoves: CardStatementLinePlanInput["bucket_repair_moves"];
} {
  let out: ReturnType<typeof readFactsAfterHeaders> | null = null;
  const read = () => {
      if (!headersOnFile) deleteJsonStatementsByIds(supersededJsonStatementIds);
      const statementIdByKey = new Map<string, number>();
      const replacedStatementIds = new Set<number>(supersededJsonStatementIds);
      for (const [key, { statement, lines }] of byStmt) {
        const header = headersOnFile
          ? { statementId: resolveCcStatementHeader(accountId, statement, lines).statementId!, existed: true }
          : upsertCcStatementHeader(accountId, statement, lines);
        statementIdByKey.set(key, header.statementId);
        if (header.existed && replaceKeys.has(key)) replacedStatementIds.add(header.statementId);
      }
      const after = listCcStatementsForAccount(accountId);
      const closedMonths: PlanClosedMonth[] = pdfClosedBillingMonthsFromImport(statements).map((bm) => {
        const pdfStatements = after.filter((st) => st.billing_month === bm && isStatementSourceKind(st.source_kind));
        return {
          billing_month: bm,
          fully_closed: hasEveryStatementTwinForBillingMonth(
            statementSlotsByBillingMonth(accountId).get(bm),
            requiredStatementCurrenciesForAccount(accountId)
          ),
          statement_currencies: [...new Set(pdfStatements.map((st) => st.currency))],
          closed_period: closedPeriodIsoRange(pdfStatements),
          next_start: nextPeriodStartIsoForBillingMonth(accountId, bm, after).iso,
          statement_ids: pdfStatements.map((st) => st.id),
        };
      });
      // Where the bucket repair moves a line (`repairMisplacedOpenWebPasteBuckets`).
      const meta = creditCardMasterMetaForAccount(accountId);
      const repairOpenBm = targetBillingMonthForManualImports(accountId, meta.cardLast4);
      const bucketRepairMoves: CardStatementLinePlanInput["bucket_repair_moves"] = [];
      const newBucketIds = new Map<string, number>();
      for (const st of after) {
        const bucketBm = parseOpenWebPasteBillingMonth(st.source_pdf);
        if (!bucketBm) continue;
        const nextStart = nextPeriodStartIsoForBillingMonth(accountId, bucketBm, after).iso;
        for (const line of listCcStatementLinesForStatement(st.id)) {
          const target = misplacedBucketLineTarget(accountId, line, bucketBm, nextStart, repairOpenBm, after);
          if (target == null) continue;
          const existing = after.find(
            (s) => s.card_group === meta.cardGroup && s.source_pdf === openWebPasteSourcePdf(target)
          );
          let to = existing?.id ?? newBucketIds.get(target);
          if (to == null) {
            to = -(newBucketIds.size + 1);
            newBucketIds.set(target, to);
          }
          if (to !== st.id) bucketRepairMoves.push({ line_id: line.id, to_statement_id: to, to_billing_month: target });
        }
      }
      out = {
        statementIdByKey,
        replacedStatementIds,
        statements: after.map(planStatementOf),
        closedMonths,
        openBillingMonth: billingMonthForManualLedgerPurchase(accountId),
        bucketRepairMoves,
      };
  };
  if (headersOnFile) {
    read();
    return out!;
  }
  try {
    db.transaction(() => {
      read();
      throw new RollBack();
    })();
  } catch (e) {
    if (!(e instanceof RollBack)) throw e;
  }
  return out!;
}

