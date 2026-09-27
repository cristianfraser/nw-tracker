/**
 * Gross amount and withholding tax behind a dividend — the tax-planning record.
 *
 * A `dividend_payout` movement carries the NET amount the broker credited, which is all the
 * balance walk and the P/L readers need, and it is also the only figure every source agrees on.
 * What the tax year needs on top — the gross dividend and the tax withheld abroad, which Chile
 * credits against the local tax on the gross — is a satellite row here, one per dividend
 * movement (migration 183, the `depto_payments` pattern). Nothing reads it on a request path
 * yet; importers write it from whatever document prints the breakdown:
 *
 *  - Racional's `/users/movements/dividends` API (`DIV` gross, `DIVTAX`, `amount` net),
 *  - Fintual's Alpaca monthly statement (Income section: the dividend line with per-share rate,
 *    position and record date, plus the «Div. Adj(NRA Withheld) … at 15% for tax country CHL»
 *    line),
 *  - Fintual's certificado de transacciones y eventos de capital (bruto / impuestos / neto).
 *
 * The writer is the one choke point. It refuses a row whose gross − withholding is not the
 * movement's own amount (a mismatch means the document and the ledger describe different
 * events, or the movement was booked gross — the 2026-09-22 bug), refuses two documents that
 * disagree about the same dividend, and otherwise lets a richer document REPLACE a poorer one
 * and a poorer document only FILL the fields the richer one left null. No field is ever
 * derived: a withholding rate is stored when the statement prints one, never computed.
 */
import { db } from "./db.js";

export const DIVIDEND_DETAIL_SOURCES = [
  "racional_api",
  "fintual_cartola",
  "fintual_certificado",
  "ibkr_statement",
  "manual",
] as const;
export type DividendDetailSource = (typeof DIVIDEND_DETAIL_SOURCES)[number];

/**
 * Which document wins when two describe the same dividend. Broker records and statements carry
 * the per-share rate, the position and the record date; the on-request certificado prints only
 * the three amounts; a manual row is a placeholder for whatever document later confirms it.
 */
export const DIVIDEND_DETAIL_SOURCE_RANK: Record<DividendDetailSource, number> = {
  manual: 0,
  fintual_certificado: 1,
  fintual_cartola: 2,
  racional_api: 2,
  ibkr_statement: 2,
};
const SOURCE_RANK = DIVIDEND_DETAIL_SOURCE_RANK;

/**
 * Each of gross, tax and net is printed rounded to the cent, so a document's own identity
 * (gross − tax = net) can be off by a cent, and the ledger's net by another half. Anything
 * beyond that is a different event, not rounding.
 */
export const DIVIDEND_DETAIL_NET_TOLERANCE = 0.015;

export type MovementDividendDetailInput = {
  movement_id: number;
  gross_amount: number;
  withholding_amount: number;
  currency: "clp" | "usd" | "eur";
  withholding_rate_pct?: number | null;
  /** Country whose tax was withheld, as the document names it (`US` for IRS NRA withholding). */
  withholding_jurisdiction?: string | null;
  /** The payee's tax residency as the broker recorded it (Alpaca prints «tax country CHL»). */
  tax_residency_country?: string | null;
  per_share_amount?: number | null;
  position_qty?: number | null;
  record_date?: string | null;
  /** The broker's own payment date; the movement may sit on the DRIP day a few days later. */
  pay_date?: string | null;
  broker_event_id?: string | null;
  source: DividendDetailSource;
  /** File name or ledger key of the document the row was read from. */
  source_ref?: string | null;
};

export type MovementDividendDetailRow = {
  movement_id: number;
  gross_amount: number;
  withholding_amount: number;
  currency: "clp" | "usd" | "eur";
  withholding_rate_pct: number | null;
  withholding_jurisdiction: string | null;
  tax_residency_country: string | null;
  per_share_amount: number | null;
  position_qty: number | null;
  record_date: string | null;
  pay_date: string | null;
  broker_event_id: string | null;
  source: DividendDetailSource;
  source_ref: string | null;
  created_at: string;
  updated_at: string;
};

export type DividendDetailUpsertOutcome = "inserted" | "replaced" | "enriched" | "unchanged";

const ENRICHABLE_FIELDS = [
  "withholding_rate_pct",
  "withholding_jurisdiction",
  "tax_residency_country",
  "per_share_amount",
  "position_qty",
  "record_date",
  "pay_date",
  "broker_event_id",
] as const;

const stmtGet = db.prepare(`SELECT * FROM movement_dividend_details WHERE movement_id = ?`);

const stmtMovement = db.prepare(
  `SELECT id, amount, currency, flow_kind, from_account_id, to_account_id
   FROM movements WHERE id = ?`
);

const stmtInsert = db.prepare(
  `INSERT INTO movement_dividend_details (
     movement_id, gross_amount, withholding_amount, currency, withholding_rate_pct,
     withholding_jurisdiction, tax_residency_country, per_share_amount, position_qty,
     record_date, pay_date, broker_event_id, source, source_ref
   ) VALUES (
     @movement_id, @gross_amount, @withholding_amount, @currency, @withholding_rate_pct,
     @withholding_jurisdiction, @tax_residency_country, @per_share_amount, @position_qty,
     @record_date, @pay_date, @broker_event_id, @source, @source_ref
   )`
);

const stmtReplace = db.prepare(
  `UPDATE movement_dividend_details SET
     gross_amount = @gross_amount, withholding_amount = @withholding_amount, currency = @currency,
     withholding_rate_pct = @withholding_rate_pct, withholding_jurisdiction = @withholding_jurisdiction,
     tax_residency_country = @tax_residency_country, per_share_amount = @per_share_amount,
     position_qty = @position_qty, record_date = @record_date, pay_date = @pay_date,
     broker_event_id = @broker_event_id, source = @source, source_ref = @source_ref,
     updated_at = datetime('now')
   WHERE movement_id = @movement_id`
);

export function getMovementDividendDetail(movementId: number): MovementDividendDetailRow | null {
  return (stmtGet.get(movementId) as MovementDividendDetailRow | undefined) ?? null;
}

export function listMovementDividendDetails(): MovementDividendDetailRow[] {
  return db
    .prepare(`SELECT * FROM movement_dividend_details ORDER BY movement_id`)
    .all() as MovementDividendDetailRow[];
}

function normalized(input: MovementDividendDetailInput): Omit<MovementDividendDetailRow, "created_at" | "updated_at"> {
  return {
    movement_id: input.movement_id,
    gross_amount: input.gross_amount,
    withholding_amount: input.withholding_amount,
    currency: input.currency,
    withholding_rate_pct: input.withholding_rate_pct ?? null,
    withholding_jurisdiction: input.withholding_jurisdiction ?? null,
    tax_residency_country: input.tax_residency_country ?? null,
    per_share_amount: input.per_share_amount ?? null,
    position_qty: input.position_qty ?? null,
    record_date: input.record_date ?? null,
    pay_date: input.pay_date ?? null,
    broker_event_id: input.broker_event_id ?? null,
    source: input.source,
    source_ref: input.source_ref ?? null,
  };
}

function sameValue(a: unknown, b: unknown): boolean {
  if (typeof a === "number" && typeof b === "number") return Math.abs(a - b) <= 1e-9;
  return a === b;
}

/**
 * Write (or refresh) the breakdown for one dividend movement.
 *
 * Throws when the movement is not a `dividend_payout` transfer, when the document's currency
 * is not the movement's, when gross − withholding is not the movement's amount, or when an
 * existing row from another document disagrees on gross or withholding. Otherwise the outcome
 * says what happened, so an importer can report it without re-reading.
 */
export function upsertMovementDividendDetail(
  input: MovementDividendDetailInput
): { outcome: DividendDetailUpsertOutcome; row: MovementDividendDetailRow } {
  if (!Number.isFinite(input.gross_amount) || input.gross_amount < 0) {
    throw new Error(`dividend detail for movement ${input.movement_id}: gross must be a non-negative number`);
  }
  if (!Number.isFinite(input.withholding_amount) || input.withholding_amount < 0) {
    throw new Error(`dividend detail for movement ${input.movement_id}: withholding must be a non-negative number`);
  }
  const movement = stmtMovement.get(input.movement_id) as
    | { id: number; amount: number; currency: string; flow_kind: string | null; from_account_id: number | null; to_account_id: number | null }
    | undefined;
  if (!movement) throw new Error(`dividend detail: movement ${input.movement_id} does not exist`);
  if (movement.flow_kind !== "dividend_payout" || movement.from_account_id == null || movement.to_account_id == null) {
    throw new Error(
      `dividend detail: movement ${input.movement_id} is not a dividend_payout transfer (flow_kind ${movement.flow_kind ?? "null"})`
    );
  }
  if (movement.currency !== input.currency) {
    throw new Error(
      `dividend detail: movement ${input.movement_id} is in ${movement.currency}, the document says ${input.currency}`
    );
  }
  const net = input.gross_amount - input.withholding_amount;
  if (Math.abs(net - Number(movement.amount)) > DIVIDEND_DETAIL_NET_TOLERANCE) {
    throw new Error(
      `dividend detail: movement ${input.movement_id} credited ${Number(movement.amount).toFixed(2)} ${movement.currency} ` +
        `but the document's gross ${input.gross_amount.toFixed(2)} − withholding ${input.withholding_amount.toFixed(2)} ` +
        `= ${net.toFixed(2)} (${input.source}${input.source_ref ? ` ${input.source_ref}` : ""}) — ` +
        `either the movement was booked gross or the document describes another dividend`
    );
  }

  const next = normalized(input);
  const existing = getMovementDividendDetail(input.movement_id);
  if (!existing) {
    stmtInsert.run(next);
    return { outcome: "inserted", row: getMovementDividendDetail(input.movement_id)! };
  }

  if (
    Math.abs(existing.gross_amount - next.gross_amount) > DIVIDEND_DETAIL_NET_TOLERANCE ||
    Math.abs(existing.withholding_amount - next.withholding_amount) > DIVIDEND_DETAIL_NET_TOLERANCE
  ) {
    throw new Error(
      `dividend detail: movement ${input.movement_id} already has gross ${existing.gross_amount} / withholding ` +
        `${existing.withholding_amount} from ${existing.source}${existing.source_ref ? ` ${existing.source_ref}` : ""}, ` +
        `and ${next.source}${next.source_ref ? ` ${next.source_ref}` : ""} says ${next.gross_amount} / ${next.withholding_amount} — ` +
        `two documents disagree about the same dividend`
    );
  }

  const rankNew = SOURCE_RANK[next.source];
  const rankOld = SOURCE_RANK[existing.source];
  if (rankNew >= rankOld) {
    // Provenance alone (`source_ref`) never justifies a rewrite: two certificados requested a
    // fortnight apart print the same rows, and the nightly re-read of both must not swap the
    // row between them forever. A substantive difference from an equal-or-better source does.
    const unchanged = (Object.keys(next) as (keyof typeof next)[]).every(
      (k) => k === "source_ref" || sameValue(existing[k], next[k])
    );
    if (unchanged) return { outcome: "unchanged", row: existing };
    stmtReplace.run(next);
    return { outcome: "replaced", row: getMovementDividendDetail(input.movement_id)! };
  }

  // A poorer document never overwrites a richer one — it only fills what the richer one lacks.
  const filled: Record<string, unknown> = { ...existing };
  let touched = false;
  for (const field of ENRICHABLE_FIELDS) {
    if (existing[field] == null && next[field] != null) {
      filled[field] = next[field];
      touched = true;
    }
  }
  if (!touched) return { outcome: "unchanged", row: existing };
  stmtReplace.run(filled);
  return { outcome: "enriched", row: getMovementDividendDetail(input.movement_id)! };
}
