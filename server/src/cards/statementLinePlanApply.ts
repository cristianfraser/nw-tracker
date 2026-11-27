/**
 * A statement import (PDF, statement JSON, the parsed corpus, an estimate) as a plan applied: the
 * statement-line planner (`statementLinePlan.ts`) says, before anything is written, which row each
 * document line ends on, and the rows follow the plan — a row on file the statement bills is
 * restated in place, never deleted and written again. {@link importStatementDocuments} is the
 * production entry (`replaceStatementLines`, the statement JSON write, the PDF upload); listings
 * (paste, feed, planted lines) never replace a row and import through the listing merge
 * (`mergeListingStatements`).
 *
 * The steps that are not about which row a document line ends on run as the merge runs them: the
 * reconcile gate, the headers, the JSON closes a PDF takes over, the feed-close and
 * one-statement-per-facturación gates, the plan ledger and its manual-plan reconcile, the one-shot
 * lines a plan supersedes, the traspaso links, the grocery branches, the bucket passes. The rows:
 *
 *  - `keep`: the row on file is restated by its document line in place (`CardLinePlan.restate`); a
 *    row a dedupe or fuzzy hit keeps (the document repeats a line on file, maybe on another
 *    statement) stays as it is, the dedupe hit's origin-card patch included;
 *  - `insert`: the document line is written (stamped unless it is a statement's cuota line);
 *  - `fold`: the row's flow folds into the kept row's, its records follow, the row goes;
 *  - `remove`, `annul` (an annulled purchase recorded first), `move_to_open`, `kept_plan_prepayment`:
 *    as the bucket settlement decides them;
 *  - an annulled purchase the statement bills after all: the billed line is written and takes the
 *    annulment's flow (or, when a line on file is the earlier arrival, the annulment's flow folds
 *    into that line's), the annulment goes; one the statement refunds with a real credit keeps the
 *    purchase and drops its synthetic refund (`bank_credit`, annulled on the credit's day).
 *
 * Ambiguity (GUIDELINES: no guesses): a re-import identity group whose counts differ has a defined
 * outcome — the vanished lines are removed (their flows retired with what was on them,
 * reported as `unpaired`) and the document lines written; anything else the plan cannot pair one to
 * one fails the import of the document with a message naming the rows, before anything is written.
 *
 * An import that changes nothing — every header on file as the import would write it, every kept
 * row already stating its document line, nothing to insert, fold, remove or settle — writes nothing
 * at all: no row, no change-log entry, no session finish.
 */
import type { CardCanonicalLine, CardCanonicalStatement, CardLineRemovedWithoutPair, CardStatementUnverifiedLines } from "nw-tracker-contracts";
import { db } from "../db.js";
import { ccStatementSourceKindOf, isListingSourceKind, isStatementSourceKind } from "../ccStatementSourceKind.js";
import {
  ccImportFlowItemFromLine,
  ccStatementLabel,
  statementsByLedgerKey,
  upsertCcStatementHeader,
  type CcImportFlowItem,
  type CcStatementsMergeResult,
  type SkippedCcImportFlowItem,
} from "../ccStatementsImport.js";
import { canonicalLineDedupeKeys, storedStatementColumns, takeBatchDedupeKeys } from "./statementStorage.js";
import { ccCardGroupOrDefault } from "../ccIssuers.js";
import { jsonStatementsSupersededByPdf, mergeInstallmentLedgerFromStatements, runBucketPasses } from "../ccInstallmentLedgerMerge.js";
import { assertCcImportReconcilesOrThrow, unverifiedStatementLines } from "../ccStatementImportReconcile.js";
import { deleteJsonStatementsByIds } from "../ccStatementJsonSource.js";
import { assertFeedClosesMatchStatements } from "../ccBillingCloses.js";
import { assertOneStatementPerFacturacion } from "./facturacion.js";
import { listCcStatementsForAccount } from "../ccStatementsDb.js";
import { reconcileManualInstallmentPurchasesAfterStatementImport } from "../ccManualInstallmentStatementReconcile.js";
import {
  applyCardLinePlan,
  applyCardLinePlanDetailed,
  planOneShotLinesSupersededByInstallmentPurchases,
  type CardLinePiecesDropped,
} from "../ccCrossImportDedupe.js";
import { relinkCcTraspasoDeudaLinksForAccount } from "../ccTraspasoDeudaLinks.js";
import { learnGroceryBranchesFromCardLines } from "../groceryBranchLearning.js";
import { patchCcLineOriginCardOnDedupeHit } from "../ccExpenseLineDedupe.js";
import { applyAdditionalCardNoCuentaForLine } from "../ccAdditionalCardExpenseMatch.js";
import {
  annulOpenBucketLines,
  deleteAnnulledPurchase,
  listAnnulledPurchases,
  markAnnulledPurchaseBankCredited,
} from "../ccAnnulledPurchases.js";
import { moveOpenBucketLinesToBillingMonth } from "../ccOpenWebPasteRepair.js";
import { installmentPurchaseLedgerDedupeKey, plansCoveringOneShotLine } from "./purchases.js";
import { describeRemovedCardLine, notifyRemovedCardLinesWithFiled } from "./removedCardLines.js";
import {
  notifyCardLineFoldConflicts,
  prepareCardLineFolds,
  type CardLineCopiesFolded,
  type CardLineFoldConflict,
} from "./foldedCardLines.js";
import { carryPlanPrepaymentLines } from "../ccPlanPrepayments.js";
import { confirmManualPaymentForPlanted, listPlantedPaymentLines } from "../ccPlantedPayments.js";
import { resolveCcExpensePurchaseKey } from "../ccExpenseCategories.js";
import { adoptFlow, flowExists, rowFlowId, type RetiredCardLineAdoption } from "../flows/flowAdoption.js";
import { compareArrival, flowArrival, olderArrival, setFlowArrival } from "../flows/flowFirstSeen.js";
import { flowIdForKey } from "../flows/flowIdentity.js";
import {
  adoptCardLineMoves,
  CC_LINE_REF_SELECT,
  ccLineRefFromRow,
  restoreLineCategories,
  snapshotLineCategories,
} from "../flows/cardLineAdoption.js";
import {
  noteCardLineEvidence,
  noteCardLineFinancingLinks,
  noteCardLineWritten,
  withCardLineSession,
  type CardLineInsert,
  type CardLineRestate,
} from "./lineWriteSession.js";
import { cardLineStatesRow, storedDocumentLine } from "./lineRowWrites.js";
import { loadCardStatementLinePlanInput } from "./statementLinePlanLoad.js";
import {
  assertPlanNamesRowsOnFile,
  planCardStatementLines,
  type CardPlanFold,
  type CardPlanKeep,
  type CardStatementLinePlan,
  type CardStatementLinePlanInput,
  type DocLineRef,
} from "./statementLinePlan.js";

export type StatementLinePlanApplyResult = {
  /** Pieces of one-shot lines a plan replaced, dropped (a plan takes none); also a notification. */
  pieces_dropped: CardLinePiecesDropped[];
  restated: number[];
  inserted: number[];
  /** New lines that took back a flow retired with their document (`takeBackRetiredCardLineFlow`), and the ones that could not. */
  retired_flows_taken_back: RetiredCardLineAdoption[];
  folded: number[];
  /** Stored copies of one line the document prints once, folded into the row it ends on. */
  copies_folded: CardLineCopiesFolded[];
  /** Folds whose rows held different assignments (notes joined, a category or big group dropped); also a notification. */
  fold_conflicts: CardLineFoldConflict[];
  removed: number[];
  annulled: number[];
  moved: number[];
  /** Annulled purchases the statement billed after all (deleted, their flow on the billed line). */
  annulments_billed: number[];
  /** Annulled purchases the statement refunded with a real credit (kept as the purchase). */
  annulments_credited: number[];
  /** The one-shot lines the plan ledger superseded. */
  overlap_removed: number;
  /** Lines removed without handing their identity to another row (`removedCardLines.ts`); also a notification when one carried what the user filed. */
  removed_without_pair: CardLineRemovedWithoutPair[];
  /** Statements imported with lines no printed figure verified (the reconcile gate's report). */
  unverified_lines: CardStatementUnverifiedLines[];
  ledger: ReturnType<typeof mergeInstallmentLedgerFromStatements>;
  manual_installment_reconcile: ReturnType<typeof reconcileManualInstallmentPurchasesAfterStatementImport>;
  grocery_branch_learning: ReturnType<typeof learnGroceryBranchesFromCardLines>;
  bucket: ReturnType<typeof runBucketPasses>;
  categories_restored: number;
};

const refOf = (d: DocLineRef): string => `${d.statement_key}#${d.index}`;

type DocLine = {
  statementId: number;
  statement: CardCanonicalStatement;
  line: CardCanonicalLine;
  dedupeKey: string | null;
  keys: string[];
  listing: boolean;
};

/** Each document line as the import stores it (its statement row and dedupe key); `statementIdOf` names the header row. */
function documentLines(statements: readonly CardCanonicalStatement[], statementIdOf: (key: string, statement: CardCanonicalStatement, lines: CardCanonicalLine[]) => number): Map<string, DocLine> {
  const docs = new Map<string, DocLine>();
  for (const [key, { statement, lines }] of statementsByLedgerKey(statements)) {
    const statementId = statementIdOf(key, statement, lines);
    const cardGroup = ccCardGroupOrDefault(statement.card_group);
    const listing = isListingSourceKind(ccStatementSourceKindOf(storedStatementColumns(statement).source_pdf));
    const seen = new Set<string>();
    lines.forEach((line, index) => {
      const taken = takeBatchDedupeKeys(seen, canonicalLineDedupeKeys(cardGroup, line));
      const keys = taken === "repeat" ? [] : taken;
      docs.set(`${key}#${index}`, { statementId, statement, line, dedupeKey: keys[keys.length - 1] ?? null, keys, listing });
    });
  }
  return docs;
}

function docOfIn(docs: ReadonlyMap<string, DocLine>, d: DocLineRef): DocLine {
  const x = docs.get(refOf(d));
  if (!x) throw new Error(`keep-rows apply: the plan names document line ${refOf(d).replace(/\t/g, " | ")}, not in the import`);
  return x;
}

const isDuplicateKeep = (k: CardPlanKeep): boolean => k.why === "dedupe_key" || k.why === "fuzzy_duplicate";

/**
 * Today's defined outcome for the plan's ambiguous entries, or a failure naming the rows (see the
 * module doc): a re-import identity group whose counts differ is already removed and written in the
 * plan (its rows reported `unpaired`); any other ambiguity throws.
 */
export function resolveStatementPlanAmbiguity(plan: CardStatementLinePlan, where: string): { plan: CardStatementLinePlan; unpaired: number[] } {
  const unpaired: number[] = [];
  const undecidable: string[] = [];
  for (const a of plan.ambiguous) {
    const removed = a.docs.length === 0 && a.rows.every((r) => r.kind === "line" && plan.remove.some((x) => x.row.id === r.id));
    if (removed) {
      unpaired.push(...a.rows.map((r) => r.id));
      continue;
    }
    const rows = a.rows.map((r) => `${r.kind === "line" ? "line" : "annulled purchase"} ${r.id}`).join(", ") || "none";
    const docs = a.docs.map((d) => `${d.statement_key.split("\t")[1] ?? d.statement_key} line #${d.index + 1}`).join(", ") || "none";
    undecidable.push(`${a.what} — rows on file: ${rows}; document lines: ${docs}`);
  }
  if (undecidable.length > 0) {
    throw new Error(`${where}: the statement import cannot pair these rows one to one, nothing was written: ${undecidable.join("; ")}`);
  }
  return { plan: { ...plan, ambiguous: [] }, unpaired };
}

/** Applies `plan` (planned for `statements` into `accountId`, see the module doc). */
export function applyStatementLinePlan(
  accountId: number,
  statements: readonly CardCanonicalStatement[],
  plan: CardStatementLinePlan,
  opts?: { replaceStatementKeys?: ReadonlySet<string>; replaceLedger?: boolean }
): StatementLinePlanApplyResult {
  if (plan.ambiguous.length > 0) throw new Error(`keep-rows apply: the plan has ${plan.ambiguous.length} ambiguous outcome(s)`);
  return withCardLineSession(accountId, "this statement import", () => applyInSession(accountId, statements, plan, opts));
}

function applyInSession(
  accountId: number,
  statements: readonly CardCanonicalStatement[],
  plan: CardStatementLinePlan,
  opts?: { replaceStatementKeys?: ReadonlySet<string>; replaceLedger?: boolean }
): StatementLinePlanApplyResult {
  // Every row the plan names as on file is one, before anything is written.
  assertPlanNamesRowsOnFile(plan, {
    file_lines: db.prepare(`SELECT l.id FROM cc_statement_lines l JOIN cc_statements s ON s.id = l.statement_id WHERE s.account_id = ?`).all(accountId) as { id: number }[],
    annulments: listAnnulledPurchases(accountId),
    incoming: [...statementsByLedgerKey(statements)].map(([key, { lines }]) => ({ key, lines })),
  });
  const json = jsonStatementsSupersededByPdf(accountId, statements);
  const replaceKeys = new Set<string>([...(opts?.replaceStatementKeys ?? []), ...json.supersededReplaceKeys]);
  const unverifiedLines = unverifiedStatementLines(
    assertCcImportReconcilesOrThrow(accountId, statements, { replaceStatementKeys: replaceKeys })
  );
  const categorySnap = snapshotLineCategories(accountId);
  const superseded = new Set(json.supersededJsonStatementIds);

  // The headers (a header already as the import states it writes nothing), and each document line
  // as it is stored.
  const dated: string[] = [];
  const note = (ymd: string | null | undefined) => {
    if (ymd) dated.push(ymd);
  };
  const docs = documentLines(statements, (_key, statement, lines) => {
    const header = upsertCcStatementHeader(accountId, statement, lines, { notStatementIds: superseded });
    if (header.changed) {
      noteCardLineWritten(accountId);
      note(storedStatementColumns(statement).monto_pagado_anterior_date);
    }
    return header.statementId;
  });
  const docOf = (d: DocLineRef) => docOfIn(docs, d);

  const annulments = new Map(listAnnulledPurchases(accountId).map((a) => [a.id, a]));
  const foldsByDoc = new Map<string, CardPlanFold[]>();
  for (const f of plan.fold) if (f.doc) foldsByDoc.set(refOf(f.doc), [...(foldsByDoc.get(refOf(f.doc)) ?? []), f]);

  const restate: CardLineRestate[] = [];
  const insert: (CardLineInsert & { doc: DocLineRef })[] = [];
  /** Annulled purchases whose flow a written document line takes (the annulment kept as the earliest). */
  const annulmentKeeps: { doc: DocLineRef; annulmentId: number; lineFolds: number[] }[] = [];
  /** Annulled purchases whose flow folds into a kept line's. */
  const annulmentFoldsIntoLine: { annulmentId: number; lineId: number }[] = [];
  const lineFolds: { fromLineId: number; intoLineId: number }[] = [];
  const copiesFolded: CardLineCopiesFolded[] = [];
  for (const k of plan.keep) {
    const d = docOf(k.doc);
    if (isDuplicateKeep(k)) {
      // The document repeats a line on file: it stays as it is (a skip), the dedupe hit's origin card patched.
      if (k.why === "dedupe_key") {
        const origin = d.line.origin_card_last4 ?? d.statement.card_last4;
        const patch = patchCcLineOriginCardOnDedupeHit(accountId, d.keys, origin, { excludeWebPasteSources: !d.listing });
        if (patch.patched) noteCardLineWritten(accountId);
        if (patch.lineId != null) additionalCard(accountId, patch.lineId, origin, d.statement.card_last4);
      }
      continue;
    }
    const folds = foldsByDoc.get(refOf(k.doc)) ?? [];
    if (k.row.kind === "line") {
      restate.push({ lineId: k.row.id, statementId: d.statementId, statement: d.statement, line: d.line, dedupeKey: d.dedupeKey });
      for (const f of folds) {
        if (f.row.kind === "line") lineFolds.push({ fromLineId: f.row.id, intoLineId: k.row.id });
        else annulmentFoldsIntoLine.push({ annulmentId: f.row.id, lineId: k.row.id });
      }
      if (k.why === "reimport_copy" || folds.some((f) => f.why === "reimport_copy")) {
        copiesFolded.push({
          line_id: k.row.id,
          merchant: d.line.merchant,
          date: d.line.transaction_date ?? d.line.posting_date ?? null,
          amount: d.line.amount,
          currency: d.line.currency,
          copies: folds.length,
        });
      }
      continue;
    }
    // An annulled purchase the statement bills, the earliest of its rows: the billed line is written
    // with no stamp of its own and takes the annulment's flow.
    for (const f of folds) if (f.row.kind !== "line") throw new Error(`keep-rows apply: two annulled purchases (${k.row.id}, ${f.row.id}) on one billed line`);
    insert.push({ doc: k.doc, statementId: d.statementId, statement: d.statement, line: d.line, dedupeKey: d.dedupeKey, stamp: false });
    annulmentKeeps.push({ doc: k.doc, annulmentId: k.row.id, lineFolds: folds.map((f) => f.row.id) });
  }
  // Folds into a line that stays (a removed duplicate copy, a bucket line or an annulled purchase a
  // statement line already on file settles).
  for (const f of plan.fold) {
    if (f.doc != null) continue;
    if (f.into.kind !== "line") throw new Error(`keep-rows apply: row ${f.row.kind} ${f.row.id} folds into an annulled purchase with no document line`);
    if (f.row.kind === "line") lineFolds.push({ fromLineId: f.row.id, intoLineId: f.into.id });
    else annulmentFoldsIntoLine.push({ annulmentId: f.row.id, lineId: f.into.id });
  }
  for (const i of plan.insert) {
    const d = docOf(i.doc);
    insert.push({ doc: i.doc, statementId: d.statementId, statement: d.statement, line: d.line, dedupeKey: d.dedupeKey, stamp: i.arrival === "stamp" });
  }

  // A planted payment the statement settles is the bank's line now: its manual payment confirmed —
  // kept and restated by its document line, or folded into the statement line that bills it.
  const planted = new Map(listPlantedPaymentLines(accountId).map((p) => [p.line_id, p]));
  const merchantOfLine = db.prepare(`SELECT merchant FROM cc_statement_lines WHERE id = ?`);
  const settledPlanted: { lineId: number; merchant: string | null }[] = [];
  for (const k of plan.keep) {
    if (k.row.kind === "line" && !isDuplicateKeep(k)) settledPlanted.push({ lineId: k.row.id, merchant: docOf(k.doc).line.merchant });
  }
  for (const f of plan.fold) {
    if (f.row.kind !== "line" || f.why !== "planted_payment") continue;
    const merchant = f.doc ? docOf(f.doc).line.merchant : ((merchantOfLine.get(f.into.id) as { merchant: string | null } | undefined)?.merchant ?? null);
    settledPlanted.push({ lineId: f.row.id, merchant });
  }
  for (const s of settledPlanted) {
    const p = planted.get(s.lineId);
    if (!p) continue;
    confirmManualPaymentForPlanted(p, s.merchant ?? "");
    db.prepare(`DELETE FROM cc_planted_payment_lines WHERE line_id = ?`).run(s.lineId);
    noteCardLineWritten(accountId);
  }
  if (restate.length > 0) {
    const gone = db
      .prepare(`DELETE FROM cc_planted_charge_lines WHERE line_id IN (${restate.map(() => "?").join(",")})`)
      .run(...restate.map((r) => r.lineId));
    if (gone.changes > 0) noteCardLineWritten(accountId);
  }

  // Annulled purchases are recorded before their lines go (they snapshot them); the ones the
  // statement refunds with a real credit keep the purchase and drop the synthetic refund.
  const statementsNow = listCcStatementsForAccount(accountId);
  const freshAnnulment = new Map<number, number>();
  for (const a of plan.annul) {
    const evidence = statementsNow.find((st) => st.billing_month === a.billing_month && isStatementSourceKind(st.source_kind))?.source_pdf;
    if (!evidence) throw new Error(`keep-rows apply: no statement of ${a.billing_month} to annul line ${a.line_id} against`);
    const res = annulOpenBucketLines(accountId, [a.line_id], { annulledOn: a.annulled_on, basis: "statement_close", evidence });
    freshAnnulment.set(a.line_id, res.annulled[0]!.id);
  }
  const credited: number[] = [];
  for (const c of plan.annulments_credited) {
    const id = c.annulled_purchase_id ?? (c.bucket_line_id != null ? freshAnnulment.get(c.bucket_line_id) : undefined);
    if (id == null) throw new Error(`keep-rows apply: a credited annulment of line ${c.bucket_line_id ?? "?"} was not recorded`);
    markAnnulledPurchaseBankCredited(id, c.credit_iso);
    credited.push(id);
  }
  if (plan.annul.length > 0 || credited.length > 0) noteCardLineWritten(accountId);

  // The rows, one plan: restated, inserted, folded (their prepayments first), removed.
  carryPlanPrepaymentLines(accountId, lineFolds.map((f) => ({ fromLineId: f.fromLineId, toLineId: f.intoLineId })));
  const supersededByPlan = new Set(plan.remove.filter((r) => r.why === "superseded_by_plan").map((r) => r.row.id));
  // A bucket line a plan covers that the supersede step did not take goes once the plans are on
  // file (the ledger merge below may write its plan), handing that plan its flow.
  const coveredByPlan = new Set(plan.remove.filter((r) => r.why === "covered_by_plan").map((r) => r.row.id));
  const removed = plan.remove.filter((r) => r.why !== "superseded_by_plan" && r.why !== "covered_by_plan").map((r) => r.row.id);
  const annulmentLineFolds = new Set(annulmentKeeps.flatMap((k) => k.lineFolds));
  // What goes with no row to take it over is described while it is still on file.
  const removedWithoutPair: CardLineRemovedWithoutPair[] = plan.remove
    .filter((r) => r.why !== "superseded_by_plan" && r.why !== "covered_by_plan" && !annulmentLineFolds.has(r.row.id))
    .map((r) => describeRemovedCardLine(r.row.id, r.why as CardLineRemovedWithoutPair["reason"], r.ambiguity ?? null));
  // What the folded rows hold apart: notes joined onto the row that stays, the rest described.
  const foldConflicts = prepareCardLineFolds(lineFolds);
  const applied = applyCardLinePlanDetailed(accountId, {
    restate,
    insert,
    fold: lineFolds,
    carry: [],
    deleteLineIds: [...removed, ...plan.annul.map((a) => a.line_id)].filter((id) => !annulmentLineFolds.has(id)),
  });
  const insertedOf = new Map(insert.map((i, n) => [refOf(i.doc), applied.inserted[n]!]));

  // The annulments the statement billed: the billed line takes the annulment's flow, or the
  // annulment's flow folds into the kept line's; then the annulment goes.
  const billed: number[] = [];
  for (const k of annulmentKeeps) {
    const lineId = insertedOf.get(refOf(k.doc))!;
    const a = annulments.get(k.annulmentId);
    if (!a) throw new Error(`keep-rows apply: annulled purchase ${k.annulmentId} is gone`);
    const arriving = rowFlowId("cc_statement_lines", lineId);
    if (arriving == null) throw new Error(`keep-rows apply: billed line ${lineId} has no flow`);
    if (flowExists(a.flow_id) && a.flow_id !== arriving) {
      // The billed line was written unstamped so that it arrives as the purchase did: the result is
      // the older arrival of every flow the adoption folds in (the annulment's, the flow its key
      // answered to, the billed key's holder) but the billed line's own, whose missing stamp would
      // read as older than any (`olderArrival`).
      const key = resolveCcExpensePurchaseKey(lineId);
      const folded = [flowIdForKey(a.purchase_key), flowIdForKey(key)].filter((f): f is number => f != null && f !== arriving && f !== a.flow_id);
      const arrival = folded.reduce((acc, f) => olderArrival(acc, flowArrival(f)), flowArrival(a.flow_id));
      adoptFlow({ survivor: a.flow_id, arriving }, { prefer: "survivor", key, previousKey: a.purchase_key });
      setFlowArrival(a.flow_id, arrival);
    }
    deleteAnnulledPurchase(a.id);
    billed.push(a.id);
    if (k.lineFolds.length > 0) {
      const folds = k.lineFolds.map((from) => ({ fromLineId: from, intoLineId: lineId }));
      carryPlanPrepaymentLines(accountId, folds.map((f) => ({ fromLineId: f.fromLineId, toLineId: f.intoLineId })));
      applyCardLinePlan(accountId, { deleteLineIds: [], carry: [], fold: folds });
    }
  }
  for (const f of annulmentFoldsIntoLine) {
    const a = annulments.get(f.annulmentId);
    if (!a) throw new Error(`keep-rows apply: annulled purchase ${f.annulmentId} is gone`);
    const survivor = rowFlowId("cc_statement_lines", f.lineId);
    if (survivor == null) throw new Error(`keep-rows apply: line ${f.lineId} has no flow`);
    if (flowExists(a.flow_id) && a.flow_id !== survivor) {
      // The earlier arrival's assignments win (ties: the line's).
      const prefer = compareArrival(flowArrival(a.flow_id), flowArrival(survivor)) < 0 ? "arriving" : "survivor";
      adoptFlow({ survivor, arriving: a.flow_id }, { prefer });
    }
    deleteAnnulledPurchase(a.id);
    billed.push(a.id);
  }
  if (billed.length > 0) noteCardLineWritten(accountId);

  // The JSON closes a PDF took over: every line of theirs is restated or removed by now.
  for (const id of superseded) {
    const left = (db.prepare(`SELECT COUNT(*) AS n FROM cc_statement_lines WHERE statement_id = ?`).get(id) as { n: number }).n;
    if (left > 0) throw new Error(`keep-rows apply: JSON statement ${id} still holds ${left} line(s) the plan does not restate or remove`);
  }
  if (superseded.size > 0) {
    deleteJsonStatementsByIds([...superseded]);
    noteCardLineWritten(accountId);
  }
  const categoriesRestored = restoreLineCategories(accountId, categorySnap);
  for (const i of insert) {
    additionalCard(accountId, insertedOf.get(refOf(i.doc))!, i.line.origin_card_last4 ?? i.statement.card_last4, i.statement.card_last4);
  }
  for (const r of restate) additionalCard(accountId, r.lineId, r.line.origin_card_last4 ?? r.statement.card_last4, r.statement.card_last4);
  // A new line beside kept lines of its identity copies their category and big group — unless it
  // took back the flow its document left retired: that flow's own classification is the line's, and
  // a twin's big group must not join a category the user gave this purchase.
  const tookBack = new Set(applied.retired_flows_taken_back.filter((t) => t.status === "adopted").map((t) => t.line_id));
  for (const i of plan.insert) {
    if (i.copies_classification_from == null) continue;
    const to = insertedOf.get(refOf(i.doc))!;
    if (tookBack.has(to)) continue;
    const refs = (db.prepare(`${CC_LINE_REF_SELECT} WHERE l.id IN (?, ?)`).all(i.copies_classification_from, to) as Parameters<typeof ccLineRefFromRow>[0][]).map(ccLineRefFromRow);
    const fromRef = refs.find((r) => r.lineId === i.copies_classification_from)!;
    const toRef = refs.find((r) => r.lineId === to)!;
    adoptCardLineMoves([{ from: fromRef, to: toRef, by: "fan_out", copy: true }]);
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
  const ledger = mergeInstallmentLedgerFromStatements(accountId, statements, { replaceLedger: opts?.replaceLedger ?? false });
  const manual = reconcileManualInstallmentPurchasesAfterStatementImport(accountId, statements);
  const overlap = planOneShotLinesSupersededByInstallmentPurchases(accountId);
  const piecesDropped = [...ledger.pieces_dropped, ...applyCardLinePlanDetailed(accountId, overlap).pieces_dropped];
  const afterLedger = lineIds();
  const gone = [...beforeLedger].filter((id) => !afterLedger.has(id));
  // A covered line the plan ledger's own supersede pass took is gone already (its flow folded into
  // that plan's); the superseded lines must all be gone, and nothing else.
  if ([...supersededByPlan].some((id) => afterLedger.has(id)) || gone.some((id) => !supersededByPlan.has(id) && !coveredByPlan.has(id))) {
    throw new Error(
      `keep-rows apply: the plans superseded lines ${gone.join(", ") || "none"}, the plan said ${[...supersededByPlan].join(", ") || "none"}`
    );
  }
  // The covered lines left: exactly one plan on file covering a line takes its flow (as a superseded
  // line's, `foldLineFlowOntoPlan`); a line two plans cover (twins) is deleted with nothing carried.
  // A cuota-tagged line the plan named by its facts (a plan the documents bring, the exact match
  // missed: another merchant, a day or two apart) folds into that plan, now on file.
  const coveredLeft = [...coveredByPlan].filter((id) => afterLedger.has(id));
  if (coveredLeft.length > 0) {
    const factsOf = new Map(plan.remove.filter((r) => r.why === "covered_by_plan" && r.plan_facts).map((r) => [r.row.id, r.plan_facts!]));
    const foldOntoPlans: { fromLineId: number; planId: number }[] = [];
    for (const id of coveredLeft) {
      // The plan the ledger merge wrote for the chain the planner named (by the chain's own
      // fingerprint: the row an upsert kept may read differently), else the one plan whose purchase
      // the line is, else nothing: the line is reported (the fold keeps identity, not money).
      const facts = factsOf.get(id);
      const fp = facts ? installmentPurchaseLedgerDedupeKey(facts) : null;
      const written = [...new Set(ledger.chain_plans.filter((c) => c.fingerprint === fp).map((c) => c.plan_id))];
      if (written.length === 1) {
        foldOntoPlans.push({ fromLineId: id, planId: written[0]! });
        continue;
      }
      const plans = plansCoveringOneShotLine(accountId, id);
      if (plans.length === 1) foldOntoPlans.push({ fromLineId: id, planId: plans[0]!.id });
      else removedWithoutPair.push(describeRemovedCardLine(id, "covered_by_plan", plans.length > 1 || written.length > 1 ? "several_candidates" : null));
    }
    piecesDropped.push(...applyCardLinePlanDetailed(accountId, { deleteLineIds: coveredLeft, carry: [], foldOntoPlans }).pieces_dropped);
  }
  notifyRemovedCardLinesWithFiled(accountId, removedWithoutPair);
  notifyCardLineFoldConflicts(accountId, foldConflicts);

  // The bucket lines the statement does not bill: on to the facturación they belong to.
  const moves = new Map<string, number[]>();
  for (const m of plan.move_to_open) moves.set(m.billing_month, [...(moves.get(m.billing_month) ?? []), m.line_id]);
  for (const [bm, ids] of moves) {
    moveOpenBucketLinesToBillingMonth(accountId, ids, bm);
    noteCardLineWritten(accountId);
  }

  relinkCcTraspasoDeudaLinksForAccount(accountId);
  const grocery = learnGroceryBranchesFromCardLines(accountId);
  const bucket = runBucketPasses(accountId, statements, null);
  note(ledger.earliestNewPurchaseDate);
  if (dated.length > 0) noteCardLineEvidence(accountId, dated.reduce((a, b) => (b < a ? b : a)));
  noteCardLineFinancingLinks(accountId);
  return {
    restated: restate.map((r) => r.lineId),
    inserted: applied.inserted,
    retired_flows_taken_back: applied.retired_flows_taken_back,
    folded: [...lineFolds.map((f) => f.fromLineId), ...annulmentKeeps.flatMap((k) => k.lineFolds)],
    copies_folded: copiesFolded,
    fold_conflicts: foldConflicts,
    removed: [...removed, ...coveredByPlan, ...supersededByPlan],
    annulled: plan.annul.map((a) => a.line_id),
    moved: plan.move_to_open.map((m) => m.line_id),
    annulments_billed: billed,
    annulments_credited: credited,
    overlap_removed: overlap.removed_line_ids.length,
    removed_without_pair: removedWithoutPair,
    unverified_lines: unverifiedLines,
    pieces_dropped: piecesDropped,
    ledger,
    manual_installment_reconcile: manual,
    grocery_branch_learning: grocery,
    bucket,
    categories_restored: categoriesRestored,
  };
}

function additionalCard(accountId: number, lineId: number, origin: string | null, primary: string | null): void {
  applyAdditionalCardNoCuentaForLine({ accountId, statementLineId: lineId, originCardLast4: origin, primaryCardLast4: primary });
}

/**
 * Whether applying `plan` would write nothing: every header on file as the import states it (the
 * loader read without a savepoint), no plan to add, no row to insert, fold, remove, annul, move or
 * settle, and every kept row already stating its document line (a dedupe hit's origin card too).
 */
export function statementPlanWritesNothing(
  accountId: number,
  statements: readonly CardCanonicalStatement[],
  input: CardStatementLinePlanInput,
  plan: CardStatementLinePlan
): boolean {
  if (!input.headers_on_file || input.json_superseded_statement_ids.length > 0 || input.document_plans_new > 0) return false;
  if (
    plan.insert.length + plan.fold.length + plan.remove.length + plan.annul.length + plan.move_to_open.length +
      plan.annulments_credited.length + plan.ambiguous.length >
    0
  ) {
    return false;
  }
  const statementIdByKey = new Map(input.incoming.map((st) => [st.key, st.statement_id]));
  const docs = documentLines(statements, (key) => statementIdByKey.get(key)!);
  const planted = new Set(input.planted_payments.map((p) => p.line_id));
  const plantedCharge = db.prepare(`SELECT 1 FROM cc_planted_charge_lines WHERE line_id = ?`);
  const origin = db.prepare(`SELECT origin_card_last4 FROM cc_statement_lines WHERE id = ?`);
  for (const k of plan.keep) {
    if (k.row.kind !== "line") return false;
    const d = docOfIn(docs, k.doc);
    if (k.why === "fuzzy_duplicate") continue;
    if (k.why === "dedupe_key") {
      const want = d.line.origin_card_last4 ?? d.statement.card_last4;
      const has = (origin.get(k.row.id) as { origin_card_last4: string | null } | undefined)?.origin_card_last4 ?? null;
      if (want && want !== has) return false;
      continue;
    }
    if (planted.has(k.row.id) || plantedCharge.get(k.row.id) != null) return false;
    const row = storedDocumentLine(d.statementId, d.statement, d.line, d.dedupeKey, `CC statement import (${d.statement.document})`);
    if (!cardLineStatesRow(k.row.id, row)) return false;
  }
  return true;
}

export type StatementDocumentsImportResult = {
  statements: CcStatementsMergeResult;
  ledger: ReturnType<typeof mergeInstallmentLedgerFromStatements>;
  /** One-shot lines the plan ledger superseded. */
  overlap_removed: number;
  /** Pieces of one-shot lines a plan replaced, dropped (a plan takes none); also a notification. */
  pieces_dropped: CardLinePiecesDropped[];
  manual_installment_reconcile: ReturnType<typeof reconcileManualInstallmentPurchasesAfterStatementImport>;
  /** Grocery receipts flagged `pending_branch` on this card that the lines just written paired with. */
  grocery_branch_learning: ReturnType<typeof learnGroceryBranchesFromCardLines>;
  bucket: ReturnType<typeof runBucketPasses>;
  /** (close, currency) pairs where an incoming PDF took over the JSON-written statement. */
  json_closes_superseded_by_pdf: string[];
  /** What the plan did with the rows on file (`statementLinePlan.ts`); `wrote` false: nothing changed. */
  keep_rows: {
    wrote: boolean;
    restated: number[];
    inserted: number[];
    folded: number[];
    /** Stored copies of one line the document prints once, folded into the row it ends on. */
    copies_folded: CardLineCopiesFolded[];
    /** Folds whose rows held different assignments; also a notification. */
    fold_conflicts: CardLineFoldConflict[];
    removed: number[];
    annulled: number[];
    moved: number[];
    annulments_billed: number[];
    annulments_credited: number[];
    /** New lines that copied the category and big group of the kept lines of their identity. */
    copied: number;
    /** Vanished lines of a re-import identity group whose counts differ: removed, their flows retired. */
    unpaired: number[];
    /** Every line removed without handing its identity to another row (the unpaired ones included), with what was filed on it. */
    removed_without_pair: CardLineRemovedWithoutPair[];
    /** Statements imported with lines no printed figure verified (`unverified_reason` of the reconcile). */
    unverified_lines: CardStatementUnverifiedLines[];
  };
};

/**
 * Statement documents (PDF, statement JSON, the parsed corpus, an estimate) into the card
 * `accountId`, as a plan applied (see the module doc). `replaceStatementKeys`: the statements whose
 * stored copies the documents restate (a re-import). Throws on a listing, on a gate, and on an
 * ambiguity no defined outcome covers — nothing written.
 */
export function importStatementDocuments(
  accountId: number,
  statements: readonly CardCanonicalStatement[],
  opts?: { replaceStatementKeys?: ReadonlySet<string>; replaceLedger?: boolean }
): StatementDocumentsImportResult {
  for (const st of statements) {
    if (isListingSourceKind(ccStatementSourceKindOf(st.document))) {
      throw new Error(`statement import: ${st.document} is a listing — listings import through insertLines`);
    }
  }
  const where = `Account ${accountId}`;
  const plannedOn = (input: CardStatementLinePlanInput) => resolveStatementPlanAmbiguity(planCardStatementLines(input), where);
  // First read only: a re-sent document already on file as it states writes nothing.
  const readOnly = loadCardStatementLinePlanInput(accountId, statements, opts);
  if (readOnly.headers_on_file) {
    const { plan, unpaired } = plannedOn(readOnly);
    if (unpaired.length === 0 && statementPlanWritesNothing(accountId, statements, readOnly, plan)) {
      return importResult(statements, plan, null, [], []);
    }
  }
  return withCardLineSession(accountId, "this statement import", () => {
    const input = readOnly.headers_on_file ? readOnly : loadCardStatementLinePlanInput(accountId, statements, opts);
    const { plan, unpaired } = plannedOn(input);
    const closes = jsonStatementsSupersededByPdf(accountId, statements).json_closes_superseded_by_pdf;
    const applied = applyInSession(accountId, statements, plan, opts);
    return importResult(statements, plan, applied, unpaired, closes);
  });
}

function importResult(
  statements: readonly CardCanonicalStatement[],
  plan: CardStatementLinePlan,
  applied: StatementLinePlanApplyResult | null,
  unpaired: number[],
  jsonClosesSuperseded: string[]
): StatementDocumentsImportResult {
  const byStmt = statementsByLedgerKey(statements);
  const lineOf = (d: DocLineRef): { line: CardCanonicalLine; label: string } => {
    const st = byStmt.get(d.statement_key);
    const line = st?.lines[d.index];
    if (!st || !line) throw new Error(`statement import: no document line ${refOf(d).replace(/\t/g, " | ")}`);
    return { line, label: ccStatementLabel(storedStatementColumns(st.statement).statement_date, st.statement.currency) };
  };
  const item = (d: DocLineRef): CcImportFlowItem => {
    const { line, label } = lineOf(d);
    return ccImportFlowItemFromLine(line, label);
  };
  const inserted_flows = plan.insert.map((i) => item(i.doc));
  const skipped_flows: SkippedCcImportFlowItem[] = [];
  let duplicate = 0;
  let fuzzy = 0;
  let overlap = 0;
  let restated = 0;
  for (const k of plan.keep) {
    if (k.why === "dedupe_key") {
      duplicate += 1;
      skipped_flows.push({ ...item(k.doc), reason: "duplicate" });
    } else if (k.why === "fuzzy_duplicate") {
      fuzzy += 1;
      skipped_flows.push({ ...item(k.doc), reason: "fuzzy_duplicate" });
    } else {
      restated += 1;
      skipped_flows.push({ ...item(k.doc), reason: "restated" });
    }
  }
  for (const s of plan.skip) {
    if (s.why === "fuzzy_duplicate") {
      fuzzy += 1;
      skipped_flows.push({ ...item(s.doc), reason: "fuzzy_duplicate" });
    } else if (s.why === "plan_on_file" || s.why === "superseded_by_plan") {
      overlap += 1;
      skipped_flows.push({ ...item(s.doc), reason: "installment_overlap" });
    } else {
      duplicate += 1;
      skipped_flows.push({ ...item(s.doc), reason: "duplicate" });
    }
  }
  const insertedDays = plan.insert.map((i) => {
    const { line } = lineOf(i.doc);
    return line.transaction_date ?? line.posting_date ?? null;
  });
  const earliestInserted = insertedDays.filter((d): d is string => d != null).sort()[0] ?? null;
  const a = applied;
  const statementsResult: CcStatementsMergeResult = {
    statementCount: byStmt.size,
    lineCount: plan.insert.length,
    linesInserted: plan.insert.length,
    linesRestated: restated,
    linesFolded: plan.fold.length,
    linesSkippedDuplicate: duplicate,
    linesSkippedFuzzyDuplicate: fuzzy,
    linesSkippedInstallmentOverlap: overlap,
    linesOriginCardPatched: 0,
    additionalCardCategoriesApplied: 0,
    categoriesRestored: a?.categories_restored ?? 0,
    earliestInsertedTxDate: earliestInserted,
    planted_same_purchase: [],
    retired_flows_taken_back: a?.retired_flows_taken_back ?? [],
    inserted_flows,
    skipped_flows,
  };
  return {
    statements: statementsResult,
    ledger: a?.ledger ?? { purchaseUpserts: 0, paymentUpserts: 0, earliestNewPurchaseDate: null, gapFilled: 0, pieces_dropped: [], stale_plans_retired_with_assignments: [], earliestChangedEvidenceDate: null, chain_plans: [] },
    overlap_removed: a?.overlap_removed ?? 0,
    pieces_dropped: a?.pieces_dropped ?? [],
    manual_installment_reconcile: a?.manual_installment_reconcile ?? emptyManualReconcile(),
    json_closes_superseded_by_pdf: jsonClosesSuperseded,
    grocery_branch_learning: a?.grocery_branch_learning ?? { learned: [], ambiguous: [] },
    bucket: a?.bucket ?? {
      truncated_merchant_dedupe: [],
      planted_payments: { replaced: [], confirmed_in_place: [], ambiguous: [], removed_from_date: null },
      recurring_pending: { replaced: [], ambiguous: [], removed_from_date: null },
    },
    keep_rows: {
      wrote: a != null,
      restated: a?.restated ?? [],
      inserted: a?.inserted ?? [],
      folded: a?.folded ?? [],
      copies_folded: a?.copies_folded ?? [],
      fold_conflicts: a?.fold_conflicts ?? [],
      removed: a?.removed ?? [],
      annulled: a?.annulled ?? [],
      moved: a?.moved ?? [],
      annulments_billed: a?.annulments_billed ?? [],
      annulments_credited: a?.annulments_credited ?? [],
      copied: plan.insert.filter((i) => i.copies_classification_from != null).length,
      unpaired,
      removed_without_pair: a?.removed_without_pair ?? [],
      unverified_lines: a?.unverified_lines ?? [],
    },
  };
}

function emptyManualReconcile(): ReturnType<typeof reconcileManualInstallmentPurchasesAfterStatementImport> {
  return { statements_considered: 0, matched: 0, deleted: 0, converted: 0, categories_transferred: 0, flows_adopted: 0, matches: [], category_spread_ambiguous: [] };
}
