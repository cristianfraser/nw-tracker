/**
 * What runtime reads about a movement instead of its note (the note is human provenance): its
 * evidence (`flow_evidence`, written with the row: the evidence kind by the importer's note shape,
 * the listing facts by the importer, `movementListingFacts.ts`), read for every movement in one
 * query and memoized until the database changes (`dbStateMemo`), so a payload builder over the
 * ledger reads it once.
 *
 * A row's description (`movementDescription`):
 *  - a cartola or daily-listing row: the description its listing printed (`stated_description`);
 *  - a row written from a mail, a ledger anchor: the description its writer stated;
 *  - any other row (typed by hand, a broker's or a legacy import's): its note, which IS its only
 *    description (shown and matched as the text a person wrote; nothing reads a field out of it).
 * A note rewritten later is the row's description from then on: the rewrite drops the listing facts
 * (migration 370's trigger), so the row describes itself by its new note.
 */
import { db } from "./db.js";
import { dbStateMemo } from "./dbStateMemo.js";
import { checkingCartolaPurchaseKeyOf } from "./checkingCartolaParse.js";
import { currencyMinorDigits, isHomeCurrency } from "./displayUnits.js";
import { signedNativeDeltaForAccountMovement, type MovementTransferRow } from "./movementTransfer.js";

type MovementRowFacts = {
  /** `flow_evidence.source_kind` (`cartola`, `daily_listing`, `mail_rebuilt`, `cartola_anchor`, `manual`, …). */
  kind: string;
  /** Trimmed; '' for none. */
  description: string;
  /** The document number a bank listing printed (null when none or not a bank listing). */
  document_no: string | null;
  /** A cartola row's branch, month, bank day, signed amount (minor units of its currency) and position. */
  branch: string | null;
  period_month: string | null;
  bank_day: string | null;
  amount_minor: number | null;
  position: number | null;
};

type EvidenceRow = Omit<MovementTransferRow, "note" | "occurred_on"> & {
  id: number;
  kind: string;
  stated_description: string | null;
  stated_document_no: string | null;
  stated_branch: string | null;
  stated_period: string | null;
  stated_on: string | null;
  stated_position: number | null;
};

/**
 * The bank's signed amount of a single-leg row on its account, in minor units: a peso row stores it
 * signed, a foreign row unsigned with its direction in its flow kind (`signedNativeDeltaForAccountMovement`).
 */
function bankSignedMinor(r: EvidenceRow): number {
  const signed = isHomeCurrency(r.currency) ? r.amount : signedNativeDeltaForAccountMovement({ ...r, note: null, occurred_on: "" }, r.account_id!, r.currency);
  return Math.round(signed * 10 ** currencyMinorDigits(r.currency));
}

function readAll(): Map<number, MovementRowFacts> {
  const rows = db
    .prepare(
      `SELECT e.source_row_id AS id, e.source_kind AS kind, e.stated_description, e.stated_document_no, e.stated_branch, e.stated_period,
              e.stated_on, e.stated_position, m.account_id, m.from_account_id, m.to_account_id, m.amount, m.currency,
              m.counter_amount, m.counter_currency, m.units_delta, m.counter_units_delta, m.flow_kind
       FROM flow_evidence e JOIN movements m ON m.id = e.source_row_id WHERE e.source_table = 'movements'`
    )
    .all() as EvidenceRow[];
  const out = new Map<number, MovementRowFacts>();
  for (const r of rows) {
    const bank = r.kind === "cartola" || r.kind === "daily_listing";
    const cartola = r.kind === "cartola" && r.stated_position != null && r.stated_period != null && r.account_id != null;
    out.set(r.id, {
      kind: r.kind,
      description: String(r.stated_description ?? "").trim(),
      document_no: bank && r.stated_document_no ? r.stated_document_no : null,
      branch: cartola ? r.stated_branch : null,
      period_month: cartola ? r.stated_period : null,
      bank_day: cartola ? r.stated_on : null,
      amount_minor: cartola ? bankSignedMinor(r) : null,
      position: cartola ? r.stated_position : null,
    });
  }
  return out;
}

/** A movement's facts; throws for a movement with no evidence (every movement has one). */
function movementRowFacts(movementId: number): MovementRowFacts {
  const f = dbStateMemo("movement_row_facts", 0, readAll).get(movementId);
  if (!f) throw new Error(`movement ${movementId}: no evidence`);
  return f;
}

/** A movement's description (see the module doc). */
export function movementDescription(movementId: number): string {
  return movementRowFacts(movementId).description;
}

/** The kinds a checking account's gastos lists: a bank listing's rows and rows written from a mail. */
const GASTOS_KINDS = new Set(["cartola", "daily_listing", "mail_notice", "mail_rebuilt"]);

/** Whether a checking movement is a bank row the gastos list reads (never a ledger anchor or a hand row). */
export function isCheckingGastosBankRow(movementId: number): boolean {
  return GASTOS_KINDS.has(movementRowFacts(movementId).kind);
}

/**
 * A cartola row's purchase key (its cartola identity: month, bank day, amount in minor units,
 * position; `checkingCartolaPurchaseKeyOf`); null for any other row.
 */
export function cartolaRowPurchaseKey(movementId: number, accountId: number, portion: "gastos" | "deposit" = "gastos"): string | null {
  const f = movementRowFacts(movementId);
  if (f.period_month == null || f.bank_day == null || f.amount_minor == null || f.position == null) return null;
  return checkingCartolaPurchaseKeyOf(accountId, { periodMonth: f.period_month, occurredOn: f.bank_day, amountClp: f.amount_minor, cartolaIndex: f.position }, portion);
}

/** What a matcher reads of a bank row's text: its description, document number and (a cartola row's) branch. */
export type BankRowText = { description: string; document_no: string | null; branch: string | null };

/** A movement's {@link BankRowText}. */
export function bankRowText(movementId: number): BankRowText {
  const f = movementRowFacts(movementId);
  return { description: f.description, document_no: f.document_no, branch: f.branch };
}
