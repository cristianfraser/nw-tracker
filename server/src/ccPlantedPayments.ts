/**
 * Card payment lines the app planted before the bank listed the payment, and their replacement
 * by the bank's own line (migration 232, `cc_planted_payment_lines`).
 *
 * A card's owed balance comes only from the bank's card lines; a `pago_tarjeta` transfer's card
 * leg is inert. So when the app knows of a payment before the bank lists it — a receipt mail
 * (`santanderCcPaymentReceipts.ts`), a payment entered by hand (`ccManualPayments.ts`) — it plants
 * the card's credit line in the open web-paste bucket and records it here, keyed by line, with
 * the import batch kind that planted it as `source`.
 *
 * The receipt path builds its line byte-identical to the feed's row, so the feed's one-shot key
 * already dedupes it. A payment made at a branch has no such template: the bank may list it as
 * «PAGO», «ABONO …» or anything else. So when a card import (feed, paste — never a planting
 * import) brings a credit payment line with the same currency and amount (USD to the cent, CLP to
 * the peso) dated from the planted day to {@link PLANTED_PAYMENT_WINDOW_DAYS} days later, and the
 * pairing is one-to-one within the import, the bank's line replaces the planted one: expense
 * assignments carried, the planted line deleted (its row cascades), the caller re-syncs the
 * valuations from the planted date. When the bank's line IS the planted line (same key) or was
 * skipped as its fuzzy twin, the planted line simply stays as the bank's. Either way a manual
 * payment is stamped confirmed. Several candidates on either side: nothing changes, reported.
 */
import { db } from "./db.js";
import { chileCalendarTodayYmd } from "./chileDate.js";
import { carryCcExpenseAssignments } from "./ccExpenseLineRekey.js";
import { earliestTransactionDateForLineIds } from "./ccCrossImportDedupe.js";
import { parseDdMmYyToIso } from "./ccInstallmentPayBy.js";
import { isCcPaymentOrUsdDebtAbonoMerchant } from "./ccPaymentLines.js";
import type { CcStatementCsvRecord } from "./ccStatementsImport.js";

/** Import batch kinds that plant a payment line (never matched against themselves). */
export const PLANTING_BATCH_KINDS = ["cc_santander_receipt", "cc_manual_payment"] as const;
export type PlantingBatchKind = (typeof PLANTING_BATCH_KINDS)[number];

export function isPlantingBatchKind(kind: string): kind is PlantingBatchKind {
  return (PLANTING_BATCH_KINDS as readonly string[]).includes(kind);
}

/** A bank lists a payment the day it was made or later — never earlier. */
export const PLANTED_PAYMENT_WINDOW_DAYS = 5;

export type PlantedPaymentRow = {
  line_id: number;
  account_id: number;
  source: PlantingBatchKind;
  currency: "clp" | "usd";
  amount: number;
  paid_on: string;
};

export type PlantedPaymentReplacement = {
  planted_line_id: number;
  bank_line_id: number;
  bank_line_merchant: string;
  bank_line_date: string;
  amount: number;
  currency: "clp" | "usd";
  source: PlantingBatchKind;
};

export type PlantedPaymentConfirmation = {
  planted_line_id: number;
  bank_line_merchant: string;
  amount: number;
  currency: "clp" | "usd";
  source: PlantingBatchKind;
};

export type PlantedPaymentAmbiguity = {
  bank_line_merchant: string;
  bank_line_date: string;
  amount: number;
  currency: "clp" | "usd";
  planted_line_ids: number[];
};

export type PlantedPaymentMatchResult = {
  replaced: PlantedPaymentReplacement[];
  confirmed_in_place: PlantedPaymentConfirmation[];
  ambiguous: PlantedPaymentAmbiguity[];
  /** Earliest transaction date of a deleted planted line — the caller's `affectedEvidenceFromYmd`. */
  removed_from_date: string | null;
};

const EMPTY_MATCH: PlantedPaymentMatchResult = {
  replaced: [],
  confirmed_in_place: [],
  ambiguous: [],
  removed_from_date: null,
};

function sameMoney(currency: "clp" | "usd", a: number, b: number): boolean {
  return currency === "usd" ? Math.round(a * 100) === Math.round(b * 100) : Math.round(a) === Math.round(b);
}

function daysFrom(fromIso: string, toIso: string): number {
  return Math.round((Date.parse(`${toIso}T00:00:00Z`) - Date.parse(`${fromIso}T00:00:00Z`)) / 86_400_000);
}

/**
 * A credit line that pays the card: the payment classifiers (PAGO, MONTO CANCELADO, ABONO, ABONO
 * DE DIVISAS) or any wording that opens with PAGO / ABONO — the bank's rendering of a payment made
 * at a branch is not known in advance. The credit sign and the exact amount do the rest.
 */
export function isPaymentLikeCreditMerchant(merchant: string | null | undefined): boolean {
  const m = String(merchant ?? "").trim().toUpperCase().replace(/\s+/g, " ");
  if (!m) return false;
  return isCcPaymentOrUsdDebtAbonoMerchant(m) || /^(PAGO|ABONO)\b/.test(m);
}

export function listPlantedPaymentLines(accountId: number): PlantedPaymentRow[] {
  return db
    .prepare(
      `SELECT line_id, account_id, source, currency, amount, paid_on
       FROM cc_planted_payment_lines WHERE account_id = ? ORDER BY paid_on, line_id`
    )
    .all(accountId) as PlantedPaymentRow[];
}

/** The account's web-paste bucket lines carrying this dedupe key. */
function webPasteLineIdsForDedupeKey(accountId: number, dedupeKey: string): number[] {
  return (
    db
      .prepare(
        `SELECT l.id FROM cc_statement_lines l
         JOIN cc_statements s ON s.id = l.statement_id
         WHERE s.account_id = ? AND s.source_pdf LIKE 'import:web-paste%' AND l.dedupe_key = ?
         ORDER BY l.id`
      )
      .all(accountId, dedupeKey) as { id: number }[]
  ).map((r) => r.id);
}

export type PlantedLineRecord =
  /** This planting wrote the line and it is now registered. */
  | { kind: "planted"; line_id: number }
  /** An earlier planting of the same payment already wrote it (a re-run). */
  | { kind: "already_planted"; line_id: number }
  /** The bank's identical listing was already on file: the import deduped onto it. */
  | { kind: "bank_line_on_file"; line_id: number; merchant: string }
  /** Nothing carries the key: the import skipped the line as the fuzzy twin of a line on file. */
  | { kind: "not_written" };

/**
 * Register the line a planting import (`inserted`: it wrote a line) left under `dedupeKey`, and
 * say what happened to it.
 */
export function recordPlantedPaymentLine(
  accountId: number,
  source: PlantingBatchKind,
  payment: { currency: "clp" | "usd"; amount: number; paid_on: string },
  dedupeKey: string,
  inserted: boolean
): PlantedLineRecord {
  const ids = webPasteLineIdsForDedupeKey(accountId, dedupeKey);
  const plantedSel = db.prepare(`SELECT line_id FROM cc_planted_payment_lines WHERE line_id = ?`);
  const already = ids.find((id) => plantedSel.get(id) != null);
  const unplanted = ids.filter((id) => id !== already);
  if (inserted) {
    const lineId = unplanted[unplanted.length - 1];
    if (lineId == null) throw new Error(`Account ${accountId}: planted payment line ${dedupeKey} is not on file`);
    db.prepare(
      `INSERT INTO cc_planted_payment_lines (line_id, account_id, source, currency, amount, paid_on)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(lineId, accountId, source, payment.currency, payment.amount, payment.paid_on);
    return { kind: "planted", line_id: lineId };
  }
  if (already != null) return { kind: "already_planted", line_id: already };
  const bankLineId = unplanted[0];
  if (bankLineId == null) return { kind: "not_written" };
  const row = db.prepare(`SELECT merchant FROM cc_statement_lines WHERE id = ?`).get(bankLineId) as {
    merchant: string | null;
  };
  return { kind: "bank_line_on_file", line_id: bankLineId, merchant: row.merchant ?? "" };
}

/**
 * Stamp the manual payment a planted line stood for as confirmed by the bank (a no-op for a
 * receipt-planted line: its confirmation is the checking debit's). Matched by card, currency,
 * amount and payment day, since line ids change.
 */
export function confirmManualPaymentForPlanted(planted: PlantedPaymentRow, bankMerchant: string): void {
  if (planted.source !== "cc_manual_payment") return;
  db.prepare(
    `UPDATE cc_manual_payments
     SET confirmed_on = ?, confirmed_by_line_merchant = ?
     WHERE id = (
       SELECT id FROM cc_manual_payments
       WHERE card_account_id = ? AND currency = ? AND ABS(amount - ?) < 0.005 AND paid_on = ?
         AND confirmed_on IS NULL
       ORDER BY id LIMIT 1
     )`
  ).run(chileCalendarTodayYmd(), bankMerchant, planted.account_id, planted.currency, planted.amount, planted.paid_on);
}

type ImportedPayment = {
  record: CcStatementCsvRecord;
  merchant: string;
  date: string;
  currency: "clp" | "usd";
  amount: number;
};

/** A record of this import that is a credit payment line, with its money in its own currency. */
function importedPayment(record: CcStatementCsvRecord): ImportedPayment | null {
  if (!isPaymentLikeCreditMerchant(record.merchant)) return null;
  const date = parseDdMmYyToIso(String(record.transaction_date ?? ""));
  if (!date) return null;
  const usd = Number(String(record.amount_usd ?? "").trim() || "0");
  const clp = Number(String(record.amount_clp ?? "").trim() || "0");
  if (!Number.isFinite(usd) || !Number.isFinite(clp)) return null;
  if (usd !== 0) return usd < 0 ? { record, merchant: record.merchant!, date, currency: "usd", amount: -usd } : null;
  if (clp < 0) return { record, merchant: record.merchant!, date, currency: "clp", amount: -clp };
  return null;
}

/**
 * Pair the credit payment lines a (non-planting) card import brought with the account's planted
 * payment lines, and let the bank's line replace each one-to-one match (see the module comment).
 * Writes inside one transaction; the caller re-syncs valuations from `removed_from_date`.
 */
export function replacePlantedPaymentLinesFromImport(
  accountId: number,
  records: readonly CcStatementCsvRecord[],
  batchKind: string
): PlantedPaymentMatchResult {
  if (isPlantingBatchKind(batchKind)) return EMPTY_MATCH;
  const planted = listPlantedPaymentLines(accountId);
  if (planted.length === 0) return EMPTY_MATCH;
  const payments = records.map(importedPayment).filter((p): p is ImportedPayment => p != null);
  if (payments.length === 0) return EMPTY_MATCH;

  const fits = (p: ImportedPayment, row: PlantedPaymentRow): boolean => {
    if (p.currency !== row.currency || !sameMoney(p.currency, p.amount, row.amount)) return false;
    const gap = daysFrom(row.paid_on, p.date);
    return gap >= 0 && gap <= PLANTED_PAYMENT_WINDOW_DAYS;
  };
  const plantedFor = payments.map((p) => planted.filter((row) => fits(p, row)));
  const paymentsFor = new Map<number, number>();
  for (const rows of plantedFor) for (const row of rows) paymentsFor.set(row.line_id, (paymentsFor.get(row.line_id) ?? 0) + 1);

  const result: PlantedPaymentMatchResult = { replaced: [], confirmed_in_place: [], ambiguous: [], removed_from_date: null };
  const toReplace: { planted: PlantedPaymentRow; bankLineId: number; payment: ImportedPayment }[] = [];
  const toConfirm: { planted: PlantedPaymentRow; payment: ImportedPayment }[] = [];
  payments.forEach((p, i) => {
    const rows = plantedFor[i]!;
    if (rows.length === 0) return;
    if (rows.length > 1 || paymentsFor.get(rows[0]!.line_id) !== 1) {
      result.ambiguous.push({
        bank_line_merchant: p.merchant,
        bank_line_date: p.date,
        amount: p.amount,
        currency: p.currency,
        planted_line_ids: rows.map((r) => r.line_id),
      });
      return;
    }
    const row = rows[0]!;
    const stored = webPasteLineIdsForDedupeKey(accountId, String(p.record.dedupe_key ?? ""));
    const bankLines = stored.filter((id) => id !== row.line_id);
    if (stored.includes(row.line_id) || bankLines.length === 0) {
      // The bank's line is the planted line itself (identical rendering), or the import skipped
      // it as the planted line's fuzzy twin: the planted line stays as the card's credit.
      toConfirm.push({ planted: row, payment: p });
      return;
    }
    if (bankLines.length > 1) {
      result.ambiguous.push({
        bank_line_merchant: p.merchant,
        bank_line_date: p.date,
        amount: p.amount,
        currency: p.currency,
        planted_line_ids: [row.line_id],
      });
      return;
    }
    toReplace.push({ planted: row, bankLineId: bankLines[0]!, payment: p });
  });
  if (toReplace.length === 0 && toConfirm.length === 0) return result;

  // Read the evidence date BEFORE deleting — afterwards the rows are gone.
  result.removed_from_date = earliestTransactionDateForLineIds(toReplace.map((r) => r.planted.line_id));
  const del = db.prepare(`DELETE FROM cc_statement_lines WHERE id = ?`);
  const unregister = db.prepare(`DELETE FROM cc_planted_payment_lines WHERE line_id = ?`);
  db.transaction(() => {
    carryCcExpenseAssignments(toReplace.map((r) => ({ fromLineId: r.planted.line_id, toLineId: r.bankLineId })));
    for (const r of toReplace) {
      confirmManualPaymentForPlanted(r.planted, r.payment.merchant);
      del.run(r.planted.line_id);
      result.replaced.push({
        planted_line_id: r.planted.line_id,
        bank_line_id: r.bankLineId,
        bank_line_merchant: r.payment.merchant,
        bank_line_date: r.payment.date,
        amount: r.planted.amount,
        currency: r.planted.currency,
        source: r.planted.source,
      });
    }
    for (const c of toConfirm) {
      confirmManualPaymentForPlanted(c.planted, c.payment.merchant);
      // The line is the bank's own now: nothing left to replace.
      unregister.run(c.planted.line_id);
      result.confirmed_in_place.push({
        planted_line_id: c.planted.line_id,
        bank_line_merchant: c.payment.merchant,
        amount: c.planted.amount,
        currency: c.planted.currency,
        source: c.planted.source,
      });
    }
  })();
  return result;
}

/**
 * A planted payment line and a statement's line for the same payment: a credit payment line in
 * the same currency, same amount, dated from the planted day to the window's end — whatever the
 * statement's wording.
 */
export function plantedPaymentMatchesStatementLine(
  planted: PlantedPaymentRow,
  stmt: { merchant: string | null; transaction_date: string | null; posting_date: string | null; amount_clp: number | null; amount_usd: number | null },
  stmtCurrency: "clp" | "usd"
): boolean {
  if (stmtCurrency !== planted.currency || !isPaymentLikeCreditMerchant(stmt.merchant)) return false;
  const raw = planted.currency === "usd" ? stmt.amount_usd : stmt.amount_clp;
  if (raw == null || raw >= 0 || !sameMoney(planted.currency, -raw, planted.amount)) return false;
  const iso = parseDdMmYyToIso(String(stmt.transaction_date ?? "")) ?? parseDdMmYyToIso(String(stmt.posting_date ?? ""));
  if (!iso) return false;
  const gap = daysFrom(planted.paid_on, iso);
  return gap >= 0 && gap <= PLANTED_PAYMENT_WINDOW_DAYS;
}
