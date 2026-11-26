/**
 * The row-level card-line writes the funnel's plans perform (`applyCardLinePlan`, inside a card-line
 * write): a document line inserted, a line on file restated by a document line in place, a line
 * folded into another. The funnel orchestrates (evidence dates, the carries that live outside the
 * flow, the deletes); these write the rows and their flows' evidence.
 *
 * **Restate** ({@link restateCardLineRow}): the row keeps its id, so its flow (`flow_id`), the flow's
 * arrival stamp and event time, and every table that names the line by id (its category override,
 * a plan converted from it, a prepayment, a learned grocery branch, a mirror merge, a traspaso link
 * rebuilt from the final lines) stay as they are. It moves to the document's statement and takes
 * every stated column of the document line — days (padded), merchant, place, description, country,
 * amounts and currency, origin amount and currency, cuota fields, dedupe key, parser row, raw line,
 * origin card, kind — exactly as an insert of that line would store them. Its evidence becomes the
 * document's (kind by the statement's source, document key, day, amount, wording, authority), the
 * evidence it had staying on the flow as history when it came from another document
 * (`keepEvidenceAsHistory`); a one-shot line's flow then answers to the line's new key and follows
 * its most trusted evidence (`adoptFlow` → `refreshFlowFromEvidence`: the document's day, amount
 * and wording). The change log sees the update (the mark trigger logs the account's old and new
 * days). A cuota line's flow is its plan's: its evidence changes, the flow does not.
 *
 * **Fold** ({@link foldCardLineFlowInto}): a row that is the same charge as a kept row — its flow
 * folds into the kept row's (the kept row's assignments win, the older arrival stays,
 * `mergeFlowInto`), its evidence kept as history; the caller deletes the row.
 */
import type { CardCanonicalLine, CardCanonicalStatement } from "nw-tracker-contracts";
import { db } from "../db.js";
import { assertStoredCardLineDates, storedLineColumns } from "./statementStorage.js";
import { ccLineOriginCurrency } from "../ccOriginCurrency.js";
import { buildExpenseKey } from "../expenseKeys.js";
import { keepEvidenceAsHistory } from "../flows/flowEvidence.js";
import { adoptFlow, foldRetiredFlowOfDocumentInto, refreshFlowFromEvidence } from "../flows/flowAdoption.js";

/** The columns a document line is stored with (the line importer's INSERT). */
const STORED = [
  "statement_id", "transaction_date", "posting_date", "place", "merchant", "description_merged", "country", "amount_orig",
  "orig_currency", "amount", "currency", "installment_flag", "nro_cuota_current", "nro_cuota_total", "cuota_amount",
  "interest_rate_text", "tipo_cuota", "dedupe_key", "parser_row_id", "raw_line", "origin_card_last4", "kind",
] as const;

export type StoredCardLine = Record<(typeof STORED)[number], unknown>;

/** The row a document line is stored as on `statementId` (`where` names the document in errors). */
export function storedDocumentLine(
  statementId: number,
  statement: CardCanonicalStatement,
  line: CardCanonicalLine,
  dedupeKey: string | null,
  where: string
): StoredCardLine {
  const columns = storedLineColumns(statement, line);
  const {
    amount_clp: _legacyClp,
    amount_usd: _legacyUsd,
    valor_cuota_mensual_clp: _legacyCuota,
    other_currency_amount: _other,
    ...stored
  } = columns as typeof columns & { other_currency_amount?: string };
  assertStoredCardLineDates(stored, where);
  return {
    statement_id: statementId,
    ...stored,
    orig_currency: ccLineOriginCurrency({
      amountOrig: columns.amount_orig,
      amountUsd: columns.amount_usd,
      dateIso: line.transaction_date ?? line.posting_date,
    }),
    dedupe_key: dedupeKey,
    kind: line.kind,
  } as StoredCardLine;
}

const insertSql = `INSERT INTO cc_statement_lines (${STORED.join(", ")}) VALUES (${STORED.map((c) => `@${c}`).join(", ")})`;

/** Inserts a stored document line; returns its id (its flow and evidence: the insert trigger's). */
export function insertStoredCardLine(row: StoredCardLine): number {
  return Number(db.prepare(insertSql).run(row).lastInsertRowid);
}

/** A card line's evidence as the insert trigger states it (`flow_cc_statement_lines_ai`, migration 319). */
const DOCUMENT_EVIDENCE_SQL = `
  SELECT l.flow_id,
    CASE s.source_kind WHEN 'listing_open' THEN 'listing_open' WHEN 'statement_json' THEN 'statement_json'
      WHEN 'statement_pdf' THEN 'statement_pdf'
      WHEN 'statement_other' THEN CASE WHEN s.source_pdf LIKE 'import:estimate|%' OR l.parser_row_id LIKE 'estimate:%' THEN 'estimate' ELSE 'statement_other' END
      ELSE 'statement_other' END AS source_kind,
    COALESCE(l.parser_row_id, l.dedupe_key) AS document_key,
    COALESCE(
      CASE WHEN length(l.transaction_date) = 8 THEN '20' || substr(l.transaction_date, 7, 2) || '-' || substr(l.transaction_date, 4, 2) || '-' || substr(l.transaction_date, 1, 2)
           WHEN length(l.transaction_date) = 10 THEN substr(l.transaction_date, 7, 4) || '-' || substr(l.transaction_date, 4, 2) || '-' || substr(l.transaction_date, 1, 2) END,
      CASE WHEN length(l.posting_date) = 8 THEN '20' || substr(l.posting_date, 7, 2) || '-' || substr(l.posting_date, 4, 2) || '-' || substr(l.posting_date, 1, 2)
           WHEN length(l.posting_date) = 10 THEN substr(l.posting_date, 7, 4) || '-' || substr(l.posting_date, 4, 2) || '-' || substr(l.posting_date, 1, 2) END
    ) AS stated_on,
    CASE WHEN l.currency = s.currency THEN l.amount ELSE 0 END AS stated_amount,
    s.currency AS stated_currency, l.merchant AS stated_description,
    CASE s.source_kind WHEN 'listing_open' THEN 2 ELSE 3 END AS authority
  FROM cc_statement_lines l JOIN cc_statements s ON s.id = l.statement_id WHERE l.id = ?`;

type LineBefore = {
  id: number;
  account_id: number;
  flow_id: number | null;
  installment_flag: number;
  parser_row_id: string | null;
  transaction_date: string | null;
  posting_date: string | null;
  merchant: string | null;
};

/** A line on file as a restate or a fold reads it; throws when it is gone or on another card. */
export function cardLineOnAccount(lineId: number, accountId: number): LineBefore {
  const row = db
    .prepare(
      `SELECT l.id, s.account_id, l.flow_id, l.installment_flag, l.parser_row_id, l.transaction_date, l.posting_date, l.merchant
       FROM cc_statement_lines l JOIN cc_statements s ON s.id = l.statement_id WHERE l.id = ?`
    )
    .get(lineId) as LineBefore | undefined;
  if (!row) throw new Error(`card line ${lineId}: gone`);
  if (row.account_id !== accountId) throw new Error(`card line ${lineId}: on account ${row.account_id}, not ${accountId}`);
  return row;
}

function linePrKey(installment: boolean, parserRowId: string | null): string | null {
  const t = String(parserRowId ?? "").trim();
  return !installment && t && !t.startsWith("synthetic:") ? buildExpenseKey({ kind: "line_pr", parserRowId: t }) : null;
}

/** The columns whose change moves money or a day (a restate that changes one notes its days). */
const MONEY_OR_DAY = new Set<string>([
  "statement_id", "transaction_date", "posting_date", "amount", "currency", "installment_flag", "nro_cuota_current",
  "nro_cuota_total", "cuota_amount",
]);

const same = (a: unknown, b: unknown): boolean => (a ?? null) === (b ?? null) || (typeof a === "number" && typeof b === "number" && a === b);

export type CardLineRestateOutcome = {
  before: LineBefore;
  /** Nothing differed: nothing was written. */
  changed: boolean;
  /** A column that moves money or a day differed (its old and new days are the write's evidence). */
  moneyOrDayChanged: boolean;
};

/**
 * Restates line `lineId` (on the card `accountId`) as the stored document line `row` (see the
 * module doc). A line that already states exactly what the document states writes nothing. Throws
 * when the line is gone, is on another card, or the statement it moves to is.
 */
export function restateCardLineRow(lineId: number, accountId: number, row: StoredCardLine): CardLineRestateOutcome {
  const before = cardLineOnAccount(lineId, accountId);
  const target = db.prepare(`SELECT account_id FROM cc_statements WHERE id = ?`).get(row.statement_id) as { account_id: number } | undefined;
  if (!target) throw new Error(`card line ${lineId}: statement ${String(row.statement_id)} does not exist`);
  if (target.account_id !== accountId) throw new Error(`card line ${lineId}: statement ${String(row.statement_id)} is on account ${target.account_id}`);
  if (before.flow_id == null) throw new Error(`card line ${lineId}: has no flow`);
  const stored = db.prepare(`SELECT ${STORED.join(", ")} FROM cc_statement_lines WHERE id = ?`).get(lineId) as StoredCardLine;
  const differing = STORED.filter((c) => !same(stored[c], row[c]));
  if (differing.length === 0) return { before, changed: false, moneyOrDayChanged: false };
  const was = db
    .prepare(`SELECT source_kind, document_key FROM flow_evidence WHERE source_table = 'cc_statement_lines' AND source_row_id = ?`)
    .get(lineId) as { source_kind: string; document_key: string | null } | undefined;
  if (!was) throw new Error(`card line ${lineId}: has no evidence`);
  const columns = differing.filter((c) => c !== "kind");
  if (columns.length > 0) {
    db.prepare(`UPDATE cc_statement_lines SET ${columns.map((c) => `${c} = @${c}`).join(", ")} WHERE id = @id`).run({
      ...Object.fromEntries(columns.map((c) => [c, row[c]])),
      id: lineId,
    });
  }
  // The kind trigger re-derives the kind from the amount and merchant; the line keeps the
  // document's, as an insert of it would.
  const kindNow = (db.prepare(`SELECT kind FROM cc_statement_lines WHERE id = ?`).get(lineId) as { kind: string | null }).kind;
  if (!same(kindNow, row.kind)) db.prepare(`UPDATE cc_statement_lines SET kind = ? WHERE id = ?`).run(row.kind, lineId);
  const doc = db.prepare(DOCUMENT_EVIDENCE_SQL).get(lineId) as {
    flow_id: number;
    source_kind: string;
    document_key: string | null;
    stated_on: string | null;
    stated_amount: number | null;
    stated_currency: string;
    stated_description: string | null;
    authority: number;
  };
  const fromAnotherDocument = was.source_kind !== doc.source_kind || was.document_key !== doc.document_key;
  if (fromAnotherDocument) {
    keepEvidenceAsHistory(db, "cc_statement_lines", lineId);
    db.prepare(
      `INSERT INTO flow_evidence (flow_id, source_kind, source_table, source_row_id, document_key, stated_on, stated_amount,
         stated_currency, stated_description, authority) VALUES (?, ?, 'cc_statement_lines', ?, ?, ?, ?, ?, ?, ?)`
    ).run(doc.flow_id, doc.source_kind, lineId, doc.document_key, doc.stated_on, doc.stated_amount, doc.stated_currency, doc.stated_description, doc.authority);
  } else {
    db.prepare(
      `UPDATE flow_evidence SET stated_on = ?, stated_amount = ?, stated_currency = ?, stated_description = ?, authority = ?
       WHERE source_table = 'cc_statement_lines' AND source_row_id = ?
         AND NOT (stated_on IS ? AND stated_amount IS ? AND stated_currency IS ? AND stated_description IS ? AND authority IS ?)`
    ).run(
      doc.stated_on, doc.stated_amount, doc.stated_currency, doc.stated_description, doc.authority, lineId,
      doc.stated_on, doc.stated_amount, doc.stated_currency, doc.stated_description, doc.authority
    );
  }
  // An earlier incarnation of the line's document, retired with what the user put on it: it folds
  // into the kept line's flow (the kept flow's assignments win, the older arrival stays).
  foldRetiredFlowOfDocumentInto(doc.flow_id, "cc_statement_lines", accountId, doc.document_key);
  const installment = Number(row.installment_flag) === 1;
  if (!installment && before.installment_flag !== 1) {
    adoptFlow(
      { survivor: before.flow_id, arriving: before.flow_id },
      {
        prefer: "survivor",
        key: linePrKey(false, row.parser_row_id as string | null),
        previousKey: linePrKey(false, before.parser_row_id),
      }
    );
  }
  return { before, changed: true, moneyOrDayChanged: differing.some((c) => MONEY_OR_DAY.has(c)) };
}

/**
 * Folds line `fromLineId`'s flow into line `intoLineId`'s (the kept row's assignments win; the
 * older arrival stays) and keeps its evidence on the flow as history. The caller deletes the line.
 */
export function foldCardLineFlowInto(fromLineId: number, intoLineId: number, accountId: number): void {
  if (fromLineId === intoLineId) throw new Error(`card line ${fromLineId}: folds into itself`);
  const from = cardLineOnAccount(fromLineId, accountId);
  const into = cardLineOnAccount(intoLineId, accountId);
  if (from.flow_id == null || into.flow_id == null) throw new Error(`card lines ${fromLineId} / ${intoLineId}: no flow`);
  // The flows first: the fold's arrival rule reads the folded line's evidence as it stood.
  if (from.flow_id !== into.flow_id) adoptFlow({ survivor: into.flow_id, arriving: from.flow_id }, { prefer: "survivor" });
  keepEvidenceAsHistory(db, "cc_statement_lines", fromLineId);
  refreshFlowFromEvidence(into.flow_id);
}
