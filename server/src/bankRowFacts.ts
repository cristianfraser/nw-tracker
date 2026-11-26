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
import { currencyMinorDigits } from "./displayUnits.js";
import { CARTOLA_KEY_COLUMNS_SQL, cartolaKeyParts, type CartolaKeyParts, type CartolaKeyRow } from "./flows/cartolaRowKey.js";

type MovementRowFacts = {
  /** `flow_evidence.source_kind` (`cartola`, `daily_listing`, `mail_rebuilt`, `cartola_anchor`, `manual`, …). */
  kind: string;
  /** Trimmed; '' for none. */
  description: string;
  /** The document number a bank listing printed (null when none or not a bank listing). */
  document_no: string | null;
  /** A cartola row's branch. */
  branch: string | null;
  /** A cartola row's identity (`cartolaRowKey.ts`); null for a row keyed by its id. */
  key: CartolaKeyParts | null;
};

type EvidenceRow = CartolaKeyRow & {
  id: number;
  kind: string;
  stated_description: string | null;
  stated_document_no: string | null;
  stated_branch: string | null;
};

/** Each movement's facts, or why they cannot be read (thrown when that movement is asked for). */
function readAll(): Map<number, MovementRowFacts | Error> {
  const rows = db
    .prepare(
      `SELECT e.source_row_id AS id, e.source_kind AS kind, e.stated_description, e.stated_document_no, e.stated_branch,
              ${CARTOLA_KEY_COLUMNS_SQL}
       FROM flow_evidence e JOIN movements m ON m.id = e.source_row_id WHERE e.source_table = 'movements'`
    )
    .all() as EvidenceRow[];
  const out = new Map<number, MovementRowFacts | Error>();
  for (const r of rows) {
    if (out.has(r.id)) {
      out.set(r.id, new Error(`movement ${r.id}: two evidence rows`));
      continue;
    }
    try {
      const bank = r.kind === "cartola" || r.kind === "daily_listing";
      out.set(r.id, {
        kind: r.kind,
        description: String(r.stated_description ?? "").trim(),
        document_no: bank && r.stated_document_no ? r.stated_document_no : null,
        branch: r.kind === "cartola" ? r.stated_branch : null,
        key: r.kind === "cartola" ? cartolaKeyParts(r, currencyMinorDigits) : null,
      });
    } catch (e) {
      out.set(r.id, new Error(`movement ${r.id}: its evidence does not read (${e instanceof Error ? e.message : String(e)})`));
    }
  }
  return out;
}

/** A movement's facts; throws, naming the movement, for one with no evidence or facts that do not read. */
function movementRowFacts(movementId: number): MovementRowFacts {
  const f = dbStateMemo("movement_row_facts", 0, readAll).get(movementId);
  if (!f) throw new Error(`movement ${movementId}: no evidence`);
  if (f instanceof Error) throw f;
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
 * A cartola row's purchase key (its cartola identity, `cartolaRowKey.ts`: the key its flow answers
 * to, resolved by `flowKeyResolve.ts` from the same facts); null for any other row.
 */
export function cartolaRowPurchaseKey(movementId: number, accountId: number, portion: "gastos" | "deposit" = "gastos"): string | null {
  const k = movementRowFacts(movementId).key;
  if (k == null) return null;
  if (k.accountId !== accountId) throw new Error(`movement ${movementId}: on account ${k.accountId}, not ${accountId}`);
  return checkingCartolaPurchaseKeyOf(accountId, { periodMonth: k.periodMonth, occurredOn: k.occurredOn, amountClp: k.amountMinor, cartolaIndex: k.cartolaIndex }, portion);
}

/** What a matcher reads of a bank row's text: its description, document number and (a cartola row's) branch. */
export type BankRowText = { description: string; document_no: string | null; branch: string | null };

/** A movement's {@link BankRowText}. */
export function bankRowText(movementId: number): BankRowText {
  const f = movementRowFacts(movementId);
  return { description: f.description, document_no: f.document_no, branch: f.branch };
}
