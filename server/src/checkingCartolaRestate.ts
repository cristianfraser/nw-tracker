/**
 * A checking account's rows restated by the cartola that lists them (keep-rows, phase 2): the row on
 * file stays and becomes the cartola's row, instead of a cartola row being inserted and the daily
 * row deleted with its flow handed over (`prunePartialMovementsSupersededByCartola`).
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
 */
import type { Database } from "better-sqlite3";
import { db } from "./db.js";
import { checkingCartolaStablePurchaseKey } from "./checkingCartolaParse.js";
import { buildExpenseKey } from "./expenseKeys.js";
import { EVIDENCE_COLUMNS, movementEvidenceValues } from "./flows/flowTriggerSpecs.js";
import { keepEvidenceAsHistory } from "./flows/flowEvidence.js";
import { expenseKeyParts, flowIdForKey, mergeFlowInto } from "./flows/flowIdentity.js";
import { occurredOnBasis, recordBankPosting } from "./movementBankPostings.js";
import { recordBankListingFacts, type BankListingFacts } from "./movementListingFacts.js";
import { deleteMovements, repointMovementReferences, restateBankRowDocument } from "./movementWrites.js";

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
};

/** Restates a bank row as its cartola row (see the module doc). */
export function restateMovementFromCartola(r: CartolaRestate, dbHandle: Database = db): void {
  const row = bankRow(r.movementId, r.accountId, dbHandle);
  if (row.kind !== "daily_listing" && row.kind !== "cartola") {
    throw new Error(`movement ${r.movementId}: a ${row.kind ?? "kind-less"} row is no bank listing's to restate`);
  }
  if (row.currency !== "clp" || row.amount !== r.amount) { // convention-ok: a Santander cartola lists pesos
    throw new Error(`movement ${r.movementId}: holds ${row.amount} ${row.currency}, the cartola lists ${r.amount} pesos`);
  }
  if (r.listed.period_month == null) throw new Error(`movement ${r.movementId}: a cartola restate names its month`);
  keepEvidenceAsHistory(dbHandle, "movements", r.movementId);
  restateBankRowDocument(r.movementId, { note: r.note, flowKind: r.flowKind }, dbHandle);
  dbHandle
    .prepare(`INSERT INTO flow_evidence (flow_id, ${EVIDENCE_COLUMNS}) SELECT m.flow_id, ${movementEvidenceValues("m")} FROM movements m WHERE m.id = ?`)
    .run(r.movementId);
  recordBankListingFacts(r.movementId, r.listed, dbHandle);
  // The cartola's day is the bank's posting day; the row's own day (a receipt's, a fetch day) stays.
  recordBankPosting(r.movementId, r.accountId, r.listed.bank_day, dbHandle, occurredOnBasis(r.movementId, r.accountId, dbHandle));
  answerToCartolaKey(r.movementId, r.accountId, r.note, row.flow_id, dbHandle);
  dbHandle.prepare(`UPDATE flows SET description = ? WHERE id = ?`).run(r.note, row.flow_id);
}

/**
 * The flow of a cartola row answers to the row's key (its cartola identity, else its id), as
 * `adoptPartialIntoCartolaRow` leaves it; a flow already answering to it folds in.
 */
function answerToCartolaKey(movementId: number, accountId: number, note: string, flowId: number, dbHandle: Database): void {
  const key =
    checkingCartolaStablePurchaseKey(accountId, note) ?? buildExpenseKey({ kind: "checking_mv", movementId, portion: "gastos" });
  const flowKey = expenseKeyParts(key)?.flowKey;
  if (!flowKey) throw new Error(`movement ${movementId}: «${key}» is not an expense key`);
  const holder = flowIdForKey(flowKey, dbHandle);
  if (holder != null && holder !== flowId) mergeFlowInto(holder, flowId, "to", dbHandle);
  dbHandle.prepare(`UPDATE flows SET legacy_key = ? WHERE id = ?`).run(flowKey, flowId);
}

/** Folds bank row `movementId` into the kept row `intoMovementId` (see the module doc). */
export function foldMovementInto(movementId: number, intoMovementId: number, accountId: number, dbHandle: Database = db): void {
  if (movementId === intoMovementId) throw new Error(`movement ${movementId}: folds into itself`);
  const row = bankRow(movementId, accountId, dbHandle);
  const kept = bankRow(intoMovementId, accountId, dbHandle);
  keepEvidenceAsHistory(dbHandle, "movements", movementId);
  mergeFlowInto(row.flow_id, kept.flow_id, "to", dbHandle);
  repointMovementReferences(movementId, intoMovementId, dbHandle);
  deleteMovements([movementId], dbHandle);
  // A cartola row kept: its flow answers to its key, as when a daily row was adopted into it.
  if (kept.kind === "cartola") {
    const note = (dbHandle.prepare(`SELECT note FROM movements WHERE id = ?`).get(intoMovementId) as { note: string }).note;
    answerToCartolaKey(intoMovementId, accountId, note, kept.flow_id, dbHandle);
  }
}
