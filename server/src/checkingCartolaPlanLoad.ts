/**
 * Reads what the cartola planner (`checkingCartolaPlan.ts`) needs for one parsed cartola month,
 * from the ledger as it stands. Writes nothing.
 *
 * **The listing-facts adapter ({@link listedFactsOfBankRow}) is the one place that still reads a
 * note**, and it is what phase 2 replaces. Of a bank row's listing facts, the structured homes hold
 * the amount (`movements.amount`) and, for a row whose day a receipt corrected, the bank's day
 * (`movement_bank_postings`); `flow_evidence` holds the whole note as `document_key` and as
 * `stated_description`, and `stated_on` is the row's day when written. Missing in structured form:
 * the listed description, the document number, the cartola month a cartola row came from, and — for
 * a daily row never re-dated — its bank day as listed (today it equals `occurred_on`, but nothing
 * states it). Until they are stored, the adapter parses them from the note exactly as today's
 * matchers do (`parsePartialMovementNote`, `cartolaNoteContent`).
 */
import type { Database } from "better-sqlite3";
import { db } from "./db.js";
import { HOME_CURRENCY, currencyMinorDigits } from "./displayUnits.js";
import { cartolaNoteContent, movementNote, type ParsedCheckingCartola } from "./checkingCartolaParse.js";
import { parsePartialMovementNote } from "./checkingCartolaPartialReconcile.js";
import { MOVEMENT_AMOUNT_COLUMNS_SQL, MOVEMENT_CLP_LEG_SQL } from "./movementAmounts.js";
import { BANK_POSTED_ON_SQL, BANK_POSTING_JOIN_SQL } from "./movementBankPostings.js";
import { signedNativeDeltaForAccountMovement, type MovementTransferRow } from "./movementTransfer.js";
import { listTransferNoticeCandidates } from "./transferNoticeMovements.js";
import { priorChileBusinessDayYmd } from "./marketHolidays.js";
import { flowArrival } from "./flows/flowFirstSeen.js";
import type { CheckingCartolaPlanInput, CheckingFileRow, CheckingListedFacts } from "./checkingCartolaPlan.js";

/**
 * PHASE 2 REPLACES THIS: a bank row's listing facts, parsed from its note (cartola rows:
 * `import:cartola|<month>|…`; daily-listing rows: `import:cartola-partial|…`). The bank day and
 * amount of a cartola row come from its columns (`bankPostedOn`, `amountClp`); a daily row's from its
 * note, as the daily↔cartola match reads them today. Null for any other row.
 */
export function listedFactsOfBankRow(
  kind: string,
  note: string | null,
  columns: { bankPostedOn: string; amountClp: number }
): CheckingListedFacts | null {
  const n = String(note ?? "");
  if (kind === "daily_listing") {
    const parsed = parsePartialMovementNote(n);
    if (!parsed) return null;
    return {
      bank_day: parsed.occurred_on,
      amount_clp: parsed.amount_clp,
      description: parsed.description,
      document_no: parsed.document_no,
      period_month: null,
    };
  }
  if (kind === "cartola") {
    const content = cartolaNoteContent(n);
    if (!content) return null;
    return {
      bank_day: columns.bankPostedOn,
      amount_clp: columns.amountClp,
      description: content.description,
      document_no: content.document_no,
      period_month: n.split("|")[1]?.trim() ?? null,
    };
  }
  return null;
}

type MovementRow = {
  id: number;
  note: string | null;
  occurred_on: string;
  amount_clp: number;
  bank_posted_on: string;
  kind: string;
  document_key: string | null;
  flow_id: number | null;
};

/** The planner's input for importing `cartola` into the checking account `accountId`. */
export function loadCheckingCartolaPlanInput(
  accountId: number,
  cartola: ParsedCheckingCartola,
  dbHandle: Database = db
): CheckingCartolaPlanInput {
  const rows = dbHandle
    .prepare(
      `SELECT m.id, m.note, m.occurred_on, ${MOVEMENT_CLP_LEG_SQL} AS amount_clp, ${BANK_POSTED_ON_SQL} AS bank_posted_on,
              e.source_kind AS kind, e.document_key, m.flow_id
       FROM movements m ${BANK_POSTING_JOIN_SQL}
       LEFT JOIN flow_evidence e ON e.source_table = 'movements' AND e.source_row_id = m.id
       WHERE m.account_id = ? ORDER BY m.id`
    )
    .all(accountId, accountId) as MovementRow[];
  const fileRows: CheckingFileRow[] = rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    document_key: r.document_key,
    bank_posted_on: r.bank_posted_on,
    occurred_on: r.occurred_on,
    amount_clp: r.amount_clp,
    listed: listedFactsOfBankRow(r.kind, r.note, { bankPostedOn: r.bank_posted_on, amountClp: r.amount_clp }),
    arrival: r.flow_id == null ? { kind: "not_an_arrival" } : flowArrival(r.flow_id, dbHandle),
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
    return {
      ...mv,
      index,
      document_key: documentKey,
      listed: listedFactsOfBankRow("cartola", documentKey, { bankPostedOn: mv.occurred_on, amountClp: mv.amount_clp })!,
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
