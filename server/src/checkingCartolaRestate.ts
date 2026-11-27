/**
 * A checking account's rows restated by the cartola that lists them: the row on file stays and
 * becomes the cartola's row.
 *
 * {@link restateMovementFromCartola}: the row keeps its id, its flow (assignments, links, arrival
 * stamp, event time), its amount (the cartola lists the same pesos: the match requires it) and its
 * day — a day a receipt or the listing's fetch day corrected stays, the cartola's day being its bank
 * posting day (`movement_bank_postings`, with the basis the row had). It takes the cartola's note
 * (its identity: `flow_evidence.document_key`, the cartola month's ownership,
 * `countExistingCartolaMovementsForMonth`) and flow kind; its evidence becomes the cartola's
 * (kind `cartola`, authority 3, the listing facts of `movementListingFacts.ts`), the daily listing's
 * evidence staying on the flow as history (`keepEvidenceAsHistory`); its flow answers to the cartola
 * row's key (a flow already answering to it folds in) and states the cartola's wording.
 *
 * {@link foldMovementInto}: a second row of the same movement folds into the kept row — its flow
 * into the kept row's (the older arrival stays, `mergeFlowInto`), its evidence kept as history, the
 * records naming it by id moved (`repointMovementReferences`), then the row deleted; a kept cartola
 * row's flow answers to its key.
 *
 * {@link foldListedRowIntoConfirmed}: a daily row whose money the cartola finds on a transfer leg
 * or a mail-written row folds into that row the same way, unless the two cannot share one flow
 * (then the daily row goes as before and the import reports it).
 */
import type { Database } from "better-sqlite3";
import { db } from "./db.js";
import { checkingCartolaPurchaseKeyOf } from "./checkingCartolaParse.js";
import { EVIDENCE_COLUMNS, movementEvidenceValues } from "./flows/flowTriggerSpecs.js";
import { keepEvidenceAsHistory } from "./flows/flowEvidence.js";
import { expenseKeyParts, flowIdForKey, mergeFlowInto } from "./flows/flowIdentity.js";
import { BANK_POSTED_ON_SQL, BANK_POSTING_JOIN_SQL, occurredOnBasis, recordBankPosting } from "./movementBankPostings.js";
import { listedFactsOfMovement, recordBankListingFacts, type BankListingFacts } from "./movementListingFacts.js";
import { foldRetiredFlowOfDocumentInto } from "./flows/flowAdoption.js";
import { compareArrival, flowArrival } from "./flows/flowFirstSeen.js";
import { deleteMovements, movementRecordsNaming, repointMovementReferences, restateBankRowDocument } from "./movementWrites.js";
import { answerToKeyWhenHolding, flowLinksMergeConflict } from "./flows/mirrorLegFlows.js";
import { cartolaRowPurchaseKey } from "./bankRowFacts.js";
import { checkingMovementPurchaseKey } from "./expenseKeys.js";

type BankRow = { id: number; account_id: number | null; amount: number; currency: string; flow_id: number | null; kind: string | null };

function bankRow(movementId: number, accountId: number, dbHandle: Database): BankRow & { flow_id: number } {
  const row = dbHandle
    .prepare(
      `SELECT m.id, m.account_id, m.amount, m.currency, m.flow_id, e.source_kind AS kind FROM movements m
       LEFT JOIN flow_evidence e ON e.source_table = 'movements' AND e.source_row_id = m.id
       WHERE m.id = ?`
    )
    .get(movementId) as BankRow | undefined;
  if (!row) throw new Error(`movement ${movementId}: gone (nothing to restate)`);
  if (row.account_id !== accountId) throw new Error(`movement ${movementId}: on account ${row.account_id ?? "(a transfer)"}, not ${accountId}`);
  if (row.flow_id == null) throw new Error(`movement ${movementId}: has no flow`);
  return row as BankRow & { flow_id: number };
}

export type CartolaRestate = {
  movementId: number;
  accountId: number;
  /** The cartola row's note (`movementNote`). */
  note: string;
  /** The cartola's signed pesos (must be the row's). */
  amount: number;
  flowKind: string | null;
  listed: BankListingFacts;
  /** The movement's position in its cartola (with the listing facts, the row's purchase key). */
  cartolaIndex: number;
};

/**
 * Restates a bank row as its cartola row (see the module doc). A row that already is that cartola
 * row (its note, kind, listing facts and posting) writes nothing; returns whether anything changed.
 */
export function restateMovementFromCartola(r: CartolaRestate, dbHandle: Database = db): boolean {
  const row = bankRow(r.movementId, r.accountId, dbHandle);
  if (row.kind !== "daily_listing" && row.kind !== "cartola") {
    throw new Error(`movement ${r.movementId}: a ${row.kind ?? "kind-less"} row is no bank listing's to restate`);
  }
  if (row.currency !== "clp" || row.amount !== r.amount) { // convention-ok: a Santander cartola lists pesos
    throw new Error(`movement ${r.movementId}: holds ${row.amount} ${row.currency}, the cartola lists ${r.amount} pesos`);
  }
  if (r.listed.period_month == null) throw new Error(`movement ${r.movementId}: a cartola restate names its month`);
  if (row.kind === "cartola" && alreadyThisCartolaRow(r, dbHandle)) return false;
  keepEvidenceAsHistory(dbHandle, "movements", r.movementId);
  restateBankRowDocument(r.movementId, { note: r.note, flowKind: r.flowKind }, dbHandle);
  dbHandle
    .prepare(`INSERT INTO flow_evidence (flow_id, ${EVIDENCE_COLUMNS}) SELECT m.flow_id, ${movementEvidenceValues("m")} FROM movements m WHERE m.id = ?`)
    .run(r.movementId);
  recordBankListingFacts(r.movementId, r.listed, dbHandle);
  // The cartola's day is the bank's posting day; the row's own day (a receipt's, a fetch day) stays.
  recordBankPosting(r.movementId, r.accountId, r.listed.bank_day, dbHandle, occurredOnBasis(r.movementId, r.accountId, dbHandle));
  // An earlier incarnation of this cartola row, retired with what the user put on it, folds in.
  foldRetiredFlowOfDocumentInto(row.flow_id, "movements", r.accountId, r.note, dbHandle);
  const key = checkingCartolaPurchaseKeyOf(r.accountId, {
    periodMonth: r.listed.period_month,
    occurredOn: r.listed.bank_day,
    amountClp: r.amount,
    cartolaIndex: r.cartolaIndex,
  });
  answerToCartolaKey(r.movementId, key, row.flow_id, dbHandle);
  dbHandle.prepare(`UPDATE flows SET description = ? WHERE id = ?`).run(r.note, row.flow_id);
  return true;
}

function alreadyThisCartolaRow(r: CartolaRestate, dbHandle: Database): boolean {
  const m = dbHandle.prepare(`SELECT note, flow_kind FROM movements WHERE id = ?`).get(r.movementId) as { note: string | null; flow_kind: string | null };
  if (m.note !== r.note || (m.flow_kind ?? null) !== (r.flowKind ?? null)) return false;
  const f = listedFactsOfMovement(r.movementId, dbHandle);
  const posted = (dbHandle.prepare(`SELECT ${BANK_POSTED_ON_SQL} AS d FROM movements m ${BANK_POSTING_JOIN_SQL} WHERE m.id = ?`).get(r.accountId, r.movementId) as { d: string }).d;
  return (
    f != null && f.bank_day === r.listed.bank_day && f.description === r.listed.description && f.document_no === r.listed.document_no &&
    f.period_month === r.listed.period_month && f.branch === r.listed.branch && f.position === r.listed.position && posted === r.listed.bank_day
  );
}

/** The flow of a cartola row answers to the row's purchase key (its cartola identity); a flow already answering to it folds in. */
function answerToCartolaKey(movementId: number, key: string, flowId: number, dbHandle: Database): void {
  const flowKey = expenseKeyParts(key)?.flowKey;
  if (!flowKey) throw new Error(`movement ${movementId}: «${key}» is not an expense key`);
  const holder = flowIdForKey(flowKey, dbHandle);
  if (holder != null && holder !== flowId) mergeFlowInto(holder, flowId, "to", dbHandle);
  dbHandle.prepare(`UPDATE flows SET legacy_key = ? WHERE id = ?`).run(flowKey, flowId);
}

/**
 * Folds bank row `movementId` into the kept row `intoMovementId` (see the module doc); a kept
 * cartola row's flow answers to `intoCartolaKey`, the purchase key of the movement it lists.
 */
export function foldMovementInto(movementId: number, intoMovementId: number, accountId: number, dbHandle: Database = db, intoCartolaKey?: string): void {
  if (movementId === intoMovementId) throw new Error(`movement ${movementId}: folds into itself`);
  const row = bankRow(movementId, accountId, dbHandle);
  const kept = bankRow(intoMovementId, accountId, dbHandle);
  // The flows first: the fold's arrival rule reads the folded row's evidence as it stood.
  // The earlier arrival's assignments win (ties: the kept row's).
  const prefer = compareArrival(flowArrival(row.flow_id, dbHandle), flowArrival(kept.flow_id, dbHandle)) < 0 ? "from" : "to";
  mergeFlowInto(row.flow_id, kept.flow_id, prefer, dbHandle);
  keepEvidenceAsHistory(dbHandle, "movements", movementId);
  repointMovementReferences(movementId, intoMovementId, dbHandle);
  deleteMovements([movementId], dbHandle);
  if (kept.kind === "cartola") {
    if (!intoCartolaKey) throw new Error(`movement ${intoMovementId}: a fold into a cartola row names its purchase key`);
    answerToCartolaKey(intoMovementId, intoCartolaKey, kept.flow_id, dbHandle);
  }
}

/** What became of a daily row the cartola removed for a transfer leg or a mail row ({@link foldListedRowIntoConfirmed}). */
export type ListedRowFold = {
  row_id: number;
  kept_row_id: number;
  /** `folded`: its flow is the kept row's now; `refused`: the two flows cannot be one, the row goes with its flow. */
  status: "folded" | "refused";
  reason: string | null;
  /** Records naming the removed row by id that go with it (`movementRecordsNaming`). */
  records_dropped: string[];
};

/**
 * Why a daily row's flow cannot fold into the flow of the row the cartola keeps for its money (null
 * when it can): a claim `mergeFlowInto` refuses or would put on a row it means nothing on. A transfer
 * (a mirror merge, a hand-entered transfer) is no spending and no income: a refund mark or an income
 * classification on the daily row stays its own, as a mirror conversion refuses a refund-marked leg.
 * Between two single-leg rows: a refund mark or an income classification on both (one per flow), and
 * the links and charges both cannot carry (`flowLinksMergeConflict`).
 */
function listedRowFoldConflict(from: number, to: number, keptIsTransfer: boolean, dbHandle: Database): string | null {
  const has = (table: string, flow: number) => dbHandle.prepare(`SELECT 1 FROM ${table} WHERE flow_id = ?`).get(flow) != null;
  for (const [table, what] of [
    ["flow_refunds", "a refund mark"],
    ["flow_income_overrides", "an income classification"],
  ] as const) {
    if (keptIsTransfer && has(table, from)) return `the daily row carries ${what} and the cartola lists its money as a transfer`;
    if (!keptIsTransfer && has(table, from) && has(table, to)) return `both rows carry ${what}`;
  }
  return flowLinksMergeConflict(from, to, dbHandle)?.detail ?? null;
}

/**
 * A daily row the cartola removes because a transfer leg or a mail-written row already lists its
 * money: its flow folds into the kept row's — the earlier arrival's assignments win (ties: the kept
 * row's), the older arrival stays (`mergeFlowInto`) — its evidence stays on the flow as history,
 * the payslip naming it moves (`repointMovementReferences`), and the kept flow answers to the kept
 * row's key when it answered to none. A fold {@link listedRowFoldConflict} refuses changes nothing.
 * The caller deletes the row either way.
 */
export function foldListedRowIntoConfirmed(movementId: number, keptMovementId: number, accountId: number, dbHandle: Database = db): ListedRowFold {
  const row = bankRow(movementId, accountId, dbHandle);
  if (row.kind !== "daily_listing") throw new Error(`movement ${movementId}: a ${row.kind ?? "kind-less"} row, not a daily listing's`);
  const kept = dbHandle.prepare(`SELECT id, account_id, flow_id FROM movements WHERE id = ?`).get(keptMovementId) as
    | { id: number; account_id: number | null; flow_id: number | null }
    | undefined;
  if (!kept) throw new Error(`movement ${keptMovementId}: gone (the cartola keeps it for movement ${movementId}'s money)`);
  if (kept.flow_id == null) throw new Error(`movement ${keptMovementId}: has no flow`);
  const keptIsTransfer = kept.account_id == null;
  const out = (status: ListedRowFold["status"], reason: string | null): ListedRowFold => ({
    row_id: movementId,
    kept_row_id: keptMovementId,
    status,
    reason,
    records_dropped: movementRecordsNaming(movementId, dbHandle),
  });
  if (row.flow_id === kept.flow_id) return out("folded", null);
  const conflict = listedRowFoldConflict(row.flow_id, kept.flow_id, keptIsTransfer, dbHandle);
  if (conflict) {
    // The payslip names the money, which the kept row lists: it moves even when the flows cannot.
    repointMovementReferences(movementId, keptMovementId, dbHandle);
    return out("refused", conflict);
  }
  const prefer = compareArrival(flowArrival(row.flow_id, dbHandle), flowArrival(kept.flow_id, dbHandle)) < 0 ? "from" : "to";
  mergeFlowInto(row.flow_id, kept.flow_id, prefer, dbHandle);
  keepEvidenceAsHistory(dbHandle, "movements", movementId);
  repointMovementReferences(movementId, keptMovementId, dbHandle);
  const keyed = (dbHandle.prepare(`SELECT legacy_key FROM flows WHERE id = ?`).get(kept.flow_id) as { legacy_key: string | null }).legacy_key;
  if (keyed == null) {
    const key = keptIsTransfer
      ? checkingMovementPurchaseKey(keptMovementId)
      : (cartolaRowPurchaseKey(keptMovementId, accountId) ?? checkingMovementPurchaseKey(keptMovementId));
    answerToKeyWhenHolding(kept.flow_id, key, dbHandle);
  }
  return out("folded", null);
}
