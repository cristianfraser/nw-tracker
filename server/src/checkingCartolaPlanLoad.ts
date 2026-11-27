/**
 * Reads what the cartola planner (`checkingCartolaPlan.ts`) needs for one parsed cartola month,
 * from the ledger as it stands. Writes nothing. A bank row's listing facts (the bank day, amount,
 * description, document and cartola month its listing printed) come from its evidence
 * (`movementListingFacts.ts`), never from its note.
 */
import type { Database } from "better-sqlite3";
import { db } from "./db.js";
import { HOME_CURRENCY, currencyMinorDigits } from "./displayUnits.js";
import { movementNote, type ParsedCheckingCartola } from "./checkingCartolaParse.js";
import { MOVEMENT_AMOUNT_COLUMNS_SQL, MOVEMENT_CLP_LEG_SQL } from "./movementAmounts.js";
import { BANK_POSTED_ON_SQL, BANK_POSTING_JOIN_SQL } from "./movementBankPostings.js";
import { signedNativeDeltaForAccountMovement, type MovementTransferRow } from "./movementTransfer.js";
import { listTransferNoticeCandidates } from "./transferNoticeMovements.js";
import { priorChileBusinessDayYmd } from "./marketHolidays.js";
import { flowArrival } from "./flows/flowFirstSeen.js";
import { flowHoldsAssignments } from "./flows/mirrorLegFlows.js";
import { cartolaListingFacts, LISTED_FACTS_COLUMNS_SQL, listedFactsOfEvidence, type ListedFactsEvidence } from "./movementListingFacts.js";
import { MOVEMENT_DELETE_BLOCKERS, type CheckingCartolaPlanInput, type CheckingFileRow } from "./checkingCartolaPlan.js";

type MovementRow = ListedFactsEvidence & {
  id: number;
  occurred_on: string;
  amount_clp: number;
  bank_posted_on: string;
  kind: string;
  document_key: string | null;
  flow_id: number | null;
};

/**
 * The planner's input for importing `cartola` into the checking account `accountId`. The rows it
 * can relate to: the daily-listing rows and the month's own cartola rows (`stated_period`); no
 * other row of the account names a movement of this month.
 */
export function loadCheckingCartolaPlanInput(
  accountId: number,
  cartola: ParsedCheckingCartola,
  dbHandle: Database = db
): CheckingCartolaPlanInput {
  const rows = dbHandle
    .prepare(
      `SELECT m.id, m.occurred_on, ${MOVEMENT_CLP_LEG_SQL} AS amount_clp, ${BANK_POSTED_ON_SQL} AS bank_posted_on,
              e.source_kind AS kind, e.document_key, m.flow_id, ${LISTED_FACTS_COLUMNS_SQL}
       FROM movements m ${BANK_POSTING_JOIN_SQL}
       JOIN flow_evidence e ON e.source_table = 'movements' AND e.source_row_id = m.id
       WHERE m.account_id = ?
         AND (e.source_kind = 'daily_listing' OR (e.source_kind = 'cartola' AND e.stated_period = ?))
       ORDER BY m.id`
    )
    .all(accountId, accountId, cartola.period_month) as MovementRow[];
  const namedBy = new Map<number, string[]>();
  for (const table of MOVEMENT_DELETE_BLOCKERS) {
    for (const { id } of dbHandle
      .prepare(`SELECT DISTINCT t.movement_id AS id FROM ${table} t JOIN movements m ON m.id = t.movement_id WHERE m.account_id = ?`)
      .all(accountId) as { id: number }[]) {
      namedBy.set(id, [...(namedBy.get(id) ?? []), table]);
    }
  }
  const fileRows: CheckingFileRow[] = rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    document_key: r.document_key,
    bank_posted_on: r.bank_posted_on,
    occurred_on: r.occurred_on,
    amount_clp: r.amount_clp,
    listed: listedFactsOfEvidence(r.id, r.kind, r),
    arrival: r.flow_id == null ? { kind: "not_an_arrival" } : flowArrival(r.flow_id, dbHandle),
    ...(namedBy.has(r.id) ? { named_by: namedBy.get(r.id)! } : {}),
    ...(r.flow_id != null && flowHoldsAssignments(r.flow_id, dbHandle) ? { filed: true } : {}),
  }));

  const legs = dbHandle
    .prepare(
      `SELECT m.id, m.account_id, m.from_account_id, m.to_account_id, ${MOVEMENT_AMOUNT_COLUMNS_SQL},
              m.occurred_on, m.note, m.units_delta, m.flow_kind, bp.posted_on
       FROM movements m ${BANK_POSTING_JOIN_SQL}
       WHERE m.account_id IS NULL AND (m.from_account_id = ? OR m.to_account_id = ?)`
    )
    .all(accountId, accountId, accountId) as (MovementTransferRow & { id: number; posted_on: string | null })[];

  const retired: Record<string, number[]> = {};
  for (const r of dbHandle
    .prepare(
      `SELECT id, retired_document_key AS k FROM flows
       WHERE retired_on IS NOT NULL AND retired_source_table = 'movements' AND retired_document_key IS NOT NULL
         AND (from_account_id = ? OR to_account_id = ?) ORDER BY id`
    )
    .all(accountId, accountId) as { id: number; k: string }[]) {
    (retired[r.k] ??= []).push(r.id);
  }

  const windowStart: Record<string, string> = {};
  const movements = cartola.movements.map((mv, index) => {
    windowStart[mv.occurred_on] ??= priorChileBusinessDayYmd(mv.occurred_on) ?? mv.occurred_on;
    const documentKey = movementNote(cartola.period_month, mv.branch, mv.description, mv.document_no, {
      occurredOn: mv.occurred_on,
      amountClp: mv.amount_clp,
      cartolaIndex: index,
    });
    const facts = cartolaListingFacts(cartola.period_month, mv, index);
    return {
      ...mv,
      index,
      document_key: documentKey,
      listed: { bank_day: facts.bank_day, amount_clp: mv.amount_clp, description: facts.description, document_no: facts.document_no, period_month: facts.period_month },
    };
  });

  return {
    account_id: accountId,
    period_month: cartola.period_month,
    movements,
    rows: fileRows,
    transfer_legs: legs.map((l) => ({
      id: l.id,
      posted_on: l.posted_on,
      occurred_on: l.occurred_on,
      signed_coins: Math.round(signedNativeDeltaForAccountMovement(l, accountId, HOME_CURRENCY) * 10 ** currencyMinorDigits(HOME_CURRENCY)),
    })),
    mail_notices: listTransferNoticeCandidates(accountId, dbHandle),
    window_start: windowStart,
    retired_flows: retired,
  };
}
