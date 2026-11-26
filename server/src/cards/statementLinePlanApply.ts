/**
 * Applies a statement-line plan (`statementLinePlan.ts`) as one card-line write: the statement
 * import's steps that are not about which row a document line ends on run as today
 * (`mergeCardStatements`: the reconcile gate, the headers, the JSON closes a PDF takes over, the
 * feed-close and one-statement-per-facturación gates, the plan ledger and its manual-plan reconcile,
 * the one-shot lines a plan supersedes, the traspaso links, the grocery branches, the bucket passes),
 * and the rows follow the plan instead of «insert every line, then settle and adopt»:
 *
 *  - `keep`: the row on file is restated by its document line in place (`CardLinePlan.restate`); a
 *    row a dedupe or fuzzy hit keeps (the document repeats a line on file, maybe on another
 *    statement) stays as it is, the dedupe hit's origin-card patch included, as today;
 *  - `insert`: the document line is written (stamped unless it is a statement's cuota line);
 *  - `fold`: the row's flow folds into the kept row's, its records follow, the row goes;
 *  - `remove`, `annul` (an annulled purchase recorded first), `move_to_open`, `kept_plan_prepayment`:
 *    as the bucket settlement does them.
 *
 * Refused (throws, nothing written): a plan with an `ambiguous` outcome, an annulment the statement
 * bills or refunds (`annulments_credited`, a kept or folded annulled purchase) — phase 3 decides
 * those —, and a plan whose superseded one-shot lines disagree with what the plan ledger leaves.
 *
 * Called by nobody in production yet (keep-rows phase 2); the equivalence tests run it beside
 * today's import.
 */
import type { CardCanonicalLine, CardCanonicalStatement } from "nw-tracker-contracts";
import { db } from "../db.js";
import { ccStatementSourceKindOf, isListingSourceKind, isStatementSourceKind } from "../ccStatementSourceKind.js";
import { statementsByLedgerKey, upsertCcStatementHeader } from "../ccStatementsImport.js";
import { canonicalLineDedupeKeys, storedStatementColumns, takeBatchDedupeKeys } from "./statementStorage.js";
import { ccCardGroupOrDefault } from "../ccIssuers.js";
import {
  jsonStatementsSupersededByPdf,
  mergeInstallmentLedgerFromStatements,
  runBucketPasses,
} from "../ccInstallmentLedgerMerge.js";
import { assertCcImportReconcilesOrThrow } from "../ccStatementImportReconcile.js";
import { deleteJsonStatementsByIds } from "../ccStatementJsonSource.js";
import { assertFeedClosesMatchStatements } from "../ccBillingCloses.js";
import { assertOneStatementPerFacturacion } from "./facturacion.js";
import { listCcStatementsForAccount } from "../ccStatementsDb.js";
import { reconcileManualInstallmentPurchasesAfterStatementImport } from "../ccManualInstallmentStatementReconcile.js";
import { applyCardLinePlan, applyCardLinePlanDetailed, planOneShotLinesSupersededByInstallmentPurchases } from "../ccCrossImportDedupe.js";
import { relinkCcTraspasoDeudaLinksForAccount } from "../ccTraspasoDeudaLinks.js";
import { learnGroceryBranchesFromCardLines } from "../groceryBranchLearning.js";
import { patchCcLineOriginCardOnDedupeHit } from "../ccExpenseLineDedupe.js";
import { applyAdditionalCardNoCuentaForLine } from "../ccAdditionalCardExpenseMatch.js";
import { annulOpenBucketLines } from "../ccAnnulledPurchases.js";
import { moveOpenBucketLinesToBillingMonth } from "../ccOpenWebPasteRepair.js";
import { carryPlanPrepaymentLines } from "../ccPlanPrepayments.js";
import { confirmManualPaymentForPlanted, listPlantedPaymentLines } from "../ccPlantedPayments.js";
import {
  adoptCardLineMoves,
  CC_LINE_REF_SELECT,
  ccLineRefFromRow,
  restoreLineCategories,
  snapshotLineCategories,
} from "../flows/cardLineAdoption.js";
import { noteCardLineEvidence, noteCardLineFinancingLinks, noteCardLineWritten, withCardLineSession, type CardLineInsert, type CardLineRestate } from "./lineWriteSession.js";
import type { CardStatementLinePlan, DocLineRef } from "./statementLinePlan.js";

export type StatementLinePlanApplyResult = {
  restated: number[];
  inserted: number[];
  folded: number[];
  removed: number[];
  annulled: number[];
  moved: number[];
};

const refOf = (d: DocLineRef): string => `${d.statement_key}#${d.index}`;

/** Applies `plan` (planned for `statements` into `accountId`, see the module doc). */
export function applyStatementLinePlan(
  accountId: number,
  statements: readonly CardCanonicalStatement[],
  plan: CardStatementLinePlan,
  opts?: { replaceStatementKeys?: ReadonlySet<string> }
): StatementLinePlanApplyResult {
  if (plan.ambiguous.length > 0) throw new Error(`keep-rows apply: the plan has ${plan.ambiguous.length} ambiguous outcome(s)`);
  if (plan.annulments_credited.length > 0) throw new Error("keep-rows apply: annulments the statement refunds are not applied yet");
  for (const r of [...plan.keep.map((k) => k.row), ...plan.fold.flatMap((f) => [f.row, f.into])]) {
    if (r.kind !== "line") throw new Error(`keep-rows apply: an annulled purchase (${r.id}) is not applied yet`);
  }
  return withCardLineSession(accountId, "statement keep-rows apply", () => applyInSession(accountId, statements, plan, opts));
}

function applyInSession(
  accountId: number,
  statements: readonly CardCanonicalStatement[],
  plan: CardStatementLinePlan,
  opts?: { replaceStatementKeys?: ReadonlySet<string> }
): StatementLinePlanApplyResult {
  const json = jsonStatementsSupersededByPdf(accountId, statements);
  const replaceKeys = new Set<string>([...(opts?.replaceStatementKeys ?? []), ...json.supersededReplaceKeys]);
  assertCcImportReconcilesOrThrow(accountId, statements, { replaceStatementKeys: replaceKeys });
  const categorySnap = snapshotLineCategories(accountId);
  const superseded = new Set(json.supersededJsonStatementIds);

  // The headers, and each document line as it is stored (its statement row and its dedupe key).
  const byStmt = statementsByLedgerKey(statements);
  const docs = new Map<string, { statementId: number; statement: CardCanonicalStatement; line: CardCanonicalLine; dedupeKey: string | null; keys: string[]; listing: boolean }>();
  const dated: string[] = [];
  const note = (ymd: string | null | undefined) => {
    if (ymd) dated.push(ymd);
  };
  for (const [key, { statement, lines }] of byStmt) {
    const stored = storedStatementColumns(statement);
    note(stored.monto_pagado_anterior_date);
    const header = upsertCcStatementHeader(accountId, statement, lines, { notStatementIds: superseded });
    const cardGroup = ccCardGroupOrDefault(statement.card_group);
    const listing = isListingSourceKind(ccStatementSourceKindOf(stored.source_pdf));
    const seen = new Set<string>();
    lines.forEach((line, index) => {
      const taken = takeBatchDedupeKeys(seen, canonicalLineDedupeKeys(cardGroup, line));
      const keys = taken === "repeat" ? [] : taken;
      docs.set(`${key}#${index}`, { statementId: header.statementId, statement, line, dedupeKey: keys[keys.length - 1] ?? null, keys, listing });
    });
  }
  const docOf = (d: DocLineRef) => {
    const x = docs.get(refOf(d));
    if (!x) throw new Error(`keep-rows apply: the plan names document line ${refOf(d).replace(/\t/g, " | ")}, not in the import`);
    return x;
  };

  const restate: CardLineRestate[] = [];
  for (const k of plan.keep) {
    const d = docOf(k.doc);
    if (k.why === "dedupe_key" || k.why === "fuzzy_duplicate") {
      // The document repeats a line on file: it stays as it is (today's skip), the dedupe hit's
      // origin card patched.
      if (k.why === "dedupe_key") {
        const origin = d.line.origin_card_last4 ?? d.statement.card_last4;
        const patch = patchCcLineOriginCardOnDedupeHit(accountId, d.keys, origin, { excludeWebPasteSources: !d.listing });
        if (patch.lineId != null) additionalCard(accountId, patch.lineId, origin, d.statement.card_last4);
      }
      continue;
    }
    restate.push({ lineId: k.row.id, statementId: d.statementId, statement: d.statement, line: d.line, dedupeKey: d.dedupeKey });
    note(d.line.transaction_date ?? d.line.posting_date);
  }
  const insert: CardLineInsert[] = plan.insert.map((i) => {
    const d = docOf(i.doc);
    note(d.line.transaction_date ?? d.line.posting_date);
    return { statementId: d.statementId, statement: d.statement, line: d.line, dedupeKey: d.dedupeKey, stamp: i.arrival === "stamp" };
  });

  // A planted payment the statement restates is the bank's line now: its manual payment confirmed.
  const planted = new Map(listPlantedPaymentLines(accountId).map((p) => [p.line_id, p]));
  for (const k of plan.keep) {
    const p = planted.get(k.row.id);
    if (!p || k.why === "dedupe_key" || k.why === "fuzzy_duplicate") continue;
    confirmManualPaymentForPlanted(p, docOf(k.doc).line.merchant);
    db.prepare(`DELETE FROM cc_planted_payment_lines WHERE line_id = ?`).run(k.row.id);
  }
  db.prepare(`DELETE FROM cc_planted_charge_lines WHERE line_id IN (${restate.map(() => "?").join(",") || "NULL"})`).run(...restate.map((r) => r.lineId));

  // Annulled purchases are recorded before their lines go (they snapshot them).
  const statementsNow = listCcStatementsForAccount(accountId);
  for (const a of plan.annul) {
    const evidence = statementsNow.find((st) => st.billing_month === a.billing_month && isStatementSourceKind(st.source_kind))?.source_pdf;
    if (!evidence) throw new Error(`keep-rows apply: no statement of ${a.billing_month} to annul line ${a.line_id} against`);
    annulOpenBucketLines(accountId, [a.line_id], { annulledOn: a.annulled_on, basis: "statement_close", evidence });
  }

  // The rows, one plan: restated, inserted, folded (their prepayments first), removed.
  const folds = plan.fold.map((f) => ({ fromLineId: f.row.id, toLineId: f.into.id }));
  carryPlanPrepaymentLines(accountId, folds);
  const supersededByPlan = new Set(plan.remove.filter((r) => r.why === "superseded_by_plan").map((r) => r.row.id));
  const removed = plan.remove.filter((r) => r.why !== "superseded_by_plan").map((r) => r.row.id);
  const applied = applyCardLinePlanDetailed(accountId, {
    restate,
    insert,
    fold: folds.map((f) => ({ fromLineId: f.fromLineId, intoLineId: f.toLineId })),
    carry: [],
    deleteLineIds: [...removed, ...plan.annul.map((a) => a.line_id)],
  });
  // The JSON closes a PDF took over: every line of theirs is restated or removed by now.
  for (const id of superseded) {
    const left = (db.prepare(`SELECT COUNT(*) AS n FROM cc_statement_lines WHERE statement_id = ?`).get(id) as { n: number }).n;
    if (left > 0) throw new Error(`keep-rows apply: JSON statement ${id} still holds ${left} line(s) the plan does not restate or remove`);
  }
  deleteJsonStatementsByIds([...superseded]);
  restoreLineCategories(accountId, categorySnap);
  for (const [lineId, d] of applied.inserted.map((id, i) => [id, insert[i]!] as const)) {
    additionalCard(accountId, lineId, d.line.origin_card_last4 ?? d.statement.card_last4, d.statement.card_last4);
  }
  for (const r of restate) additionalCard(accountId, r.lineId, r.line.origin_card_last4 ?? r.statement.card_last4, r.statement.card_last4);
  // A new line beside kept lines of its identity copies their category and big group (today's re-import copies).
  const insertedByDoc = new Map(plan.insert.map((i, n) => [refOf(i.doc), applied.inserted[n]!]));
  for (const i of plan.insert) {
    if (i.copies_classification_from == null) continue;
    const refs = (db.prepare(`${CC_LINE_REF_SELECT} WHERE l.id IN (?, ?)`).all(i.copies_classification_from, insertedByDoc.get(refOf(i.doc))!) as Parameters<typeof ccLineRefFromRow>[0][]).map(ccLineRefFromRow);
    const from = refs.find((r) => r.lineId === i.copies_classification_from)!;
    const to = refs.find((r) => r.lineId === insertedByDoc.get(refOf(i.doc)))!;
    adoptCardLineMoves([{ from, to, by: "fan_out", copy: true, classificationOnly: true }]);
  }

  assertFeedClosesMatchStatements(accountId);
  assertOneStatementPerFacturacion(listCcStatementsForAccount(accountId), `Account ${accountId}`);
  // The plan ledger (and its own pass over the one-shot lines its plans supersede), the manual-plan
  // reconcile, the overlap pass: the lines they remove must be the ones the plan says.
  const lineIds = () =>
    new Set(
      (db.prepare(`SELECT l.id FROM cc_statement_lines l JOIN cc_statements s ON s.id = l.statement_id WHERE s.account_id = ?`).all(accountId) as { id: number }[]).map(
        (r) => r.id
      )
    );
  const beforeLedger = lineIds();
  const ledger = mergeInstallmentLedgerFromStatements(accountId, statements, { replaceLedger: false });
  reconcileManualInstallmentPurchasesAfterStatementImport(accountId, statements);
  applyCardLinePlan(accountId, planOneShotLinesSupersededByInstallmentPurchases(accountId));
  const afterLedger = lineIds();
  const gone = [...beforeLedger].filter((id) => !afterLedger.has(id));
  if (gone.length !== supersededByPlan.size || gone.some((id) => !supersededByPlan.has(id))) {
    throw new Error(
      `keep-rows apply: the plans superseded lines ${gone.join(", ") || "none"}, the plan said ${[...supersededByPlan].join(", ") || "none"}`
    );
  }

  // The bucket lines the statement does not bill: on to the facturación they belong to.
  const moves = new Map<string, number[]>();
  for (const m of plan.move_to_open) moves.set(m.billing_month, [...(moves.get(m.billing_month) ?? []), m.line_id]);
  for (const [bm, ids] of moves) {
    moveOpenBucketLinesToBillingMonth(accountId, ids, bm);
    noteCardLineWritten(accountId);
  }

  relinkCcTraspasoDeudaLinksForAccount(accountId);
  learnGroceryBranchesFromCardLines(accountId);
  runBucketPasses(accountId, statements, null);
  note(ledger.earliestNewPurchaseDate);
  noteCardLineEvidence(accountId, dated.length > 0 ? dated.reduce((a, b) => (b < a ? b : a)) : null);
  noteCardLineFinancingLinks(accountId);
  return {
    restated: restate.map((r) => r.lineId),
    inserted: applied.inserted,
    folded: folds.map((f) => f.fromLineId),
    removed: [...removed, ...supersededByPlan],
    annulled: plan.annul.map((a) => a.line_id),
    moved: plan.move_to_open.map((m) => m.line_id),
  };
}

function additionalCard(accountId: number, lineId: number, origin: string | null, primary: string | null): void {
  applyAdditionalCardNoCuentaForLine({ accountId, statementLineId: lineId, originCardLast4: origin, primaryCardLast4: primary });
}
