/**
 * Card payment lines the app planted before the bank listed the payment, and their replacement
 * by the bank's own line (migration 232, `cc_planted_payment_lines`).
 *
 * A card's owed balance comes only from the bank's card lines; a `pago_tarjeta` transfer's card
 * leg is inert. So when the app knows of a payment before the bank lists it — a receipt mail
 * (`santanderCcPaymentReceipts.ts`), a payment entered by hand (`ccManualPayments.ts`), the PAGO
 * the facturado-financing matcher plants on a paid card (`cards/lineWrites.ts`) — it plants
 * the card's credit line in the open web-paste bucket and records it here, keyed by line, with
 * the import batch kind that planted it as `source`.
 *
 * The receipt path builds its line byte-identical to the feed's row, so the feed's one-shot key
 * already dedupes it. A payment made at a branch has no such template: the bank may list it as
 * «PAGO», «ABONO …» or anything else. So when a card import (feed, paste — never a planting
 * import) brings a credit payment line with the same currency and amount (to the currency's
 * smallest coin) dated from the planted day to `MATCH_WINDOWS.planted_payment` days later, and the
 * pairing is one-to-one within the import, the bank's line replaces the planted one: expense
 * assignments carried, the planted line deleted (its row cascades), the caller re-syncs the
 * valuations from the planted date. When the bank's line IS the planted line (same key) or was
 * skipped as its fuzzy twin, the planted line simply stays as the bank's. Either way a manual
 * payment is stamped confirmed. Several candidates on either side: nothing changes, reported.
 */
import { db } from "./db.js";
import { chileCalendarTodayYmd } from "./chileDate.js";
import { normalizeTransactionDateIso } from "./ccInstallmentPayBy.js";
import { EMPTY_CARD_LINE_PLAN, type CardLinePlan } from "./cards/lineWriteSession.js";
import { isCcPaymentOrUsdDebtAbonoMerchant } from "./ccPaymentLines.js";
import type { CardCanonicalLine, CardCanonicalStatement } from "nw-tracker-contracts";
import { dayWithinWindow, parseDdMmYyToIso } from "nw-tracker-contracts";
import { MATCH_WINDOWS } from "./matching/windows.js";
import { pairOneToOne } from "./matching/pairing.js";
import { sameCoin } from "./matching/money.js";

/** Import batch kinds that plant a payment line (never matched against themselves). */
export const PLANTING_BATCH_KINDS = ["cc_santander_receipt", "cc_manual_payment", "cc_financing_payment"] as const;
export type PlantingBatchKind = (typeof PLANTING_BATCH_KINDS)[number];

export function isPlantingBatchKind(kind: string): kind is PlantingBatchKind {
  return (PLANTING_BATCH_KINDS as readonly string[]).includes(kind);
}

// A bank lists a payment the day it was made or later — never earlier (`MATCH_WINDOWS.planted_payment`).

export type PlantedPaymentRow = {
  line_id: number;
  account_id: number;
  source: PlantingBatchKind;
  currency: string;
  amount: number;
  paid_on: string;
};

export type PlantedPaymentReplacement = {
  planted_line_id: number;
  bank_line_id: number;
  bank_line_merchant: string;
  bank_line_date: string;
  amount: number;
  currency: string;
  source: PlantingBatchKind;
};

export type PlantedPaymentConfirmation = {
  planted_line_id: number;
  bank_line_merchant: string;
  amount: number;
  currency: string;
  source: PlantingBatchKind;
};

export type PlantedPaymentAmbiguity = {
  bank_line_merchant: string;
  bank_line_date: string;
  amount: number;
  currency: string;
  planted_line_ids: number[];
};

export type PlantedPaymentMatchResult = {
  replaced: PlantedPaymentReplacement[];
  confirmed_in_place: PlantedPaymentConfirmation[];
  ambiguous: PlantedPaymentAmbiguity[];
  /** Earliest transaction date of a deleted planted line (the funnel re-syncs from it). */
  removed_from_date: string | null;
};

/** The match, and the card-line funnel's plan: each replaced planted line, its assignments carried. */
export type PlantedPaymentReplacementPlan = { result: PlantedPaymentMatchResult; plan: CardLinePlan };

const EMPTY_MATCH: PlantedPaymentMatchResult = {
  replaced: [],
  confirmed_in_place: [],
  ambiguous: [],
  removed_from_date: null,
};

/** A payment as a document states it: its currency, its amount in it (positive) and its ISO day. */
export type PaymentFacts = { currency: string; amount: number; date: string };

/**
 * The one rule that says a bank's payment is a planted payment: same currency, the same amount to
 * the currency's coin, dated inside `MATCH_WINDOWS.planted_payment` of the planted day. The import
 * pairing and the statement reconcile both ask it (the wording is the caller's candidate filter).
 */
export function plantedPaymentFits(planted: Pick<PlantedPaymentRow, "currency" | "amount" | "paid_on">, payment: PaymentFacts): boolean {
  if (payment.currency !== planted.currency || !sameCoin(payment.amount, planted.amount, planted.currency)) return false;
  return dayWithinWindow(planted.paid_on, payment.date, MATCH_WINDOWS.planted_payment);
}

/**
 * The import's payments against the account's planted lines, one-to-one both ways
 * (`mutual_unique`): a payment pairs with the one planted line it fits when no other payment of
 * the import fits that line; any other payment that fits a planted line is ambiguous. Pure.
 */
export function pairPaymentsWithPlanted<P extends PaymentFacts, R extends Pick<PlantedPaymentRow, "currency" | "amount" | "paid_on">>(
  payments: readonly P[],
  planted: readonly R[]
): { pairs: { payment: P; planted: R }[]; ambiguous: { payment: P; planted: R[] }[] } {
  const out = pairOneToOne(payments, planted, { strategy: "mutual_unique", accepts: (p, row) => plantedPaymentFits(row, p) });
  return {
    pairs: out.pairs.map((p) => ({ payment: p.left, planted: p.right })),
    ambiguous: out.ambiguous.map((a) => ({ payment: a.left, planted: a.rights })),
  };
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
         WHERE s.account_id = ? AND s.source_kind IN ('listing_open', 'listing_other') AND l.dedupe_key = ?
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
  payment: { currency: string; amount: number; paid_on: string },
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
  line: CardCanonicalLine;
  merchant: string;
  date: string;
  currency: string;
  amount: number;
};

/** A line of this import that is a credit payment line, with its money in its own currency. */
function importedPayment(line: CardCanonicalLine): ImportedPayment | null {
  if (!isPaymentLikeCreditMerchant(line.merchant)) return null;
  const date = line.transaction_date;
  if (!date) return null;
  // A credit in the line's own currency, whichever it is.
  return line.amount < 0 ? { line, merchant: line.merchant, date, currency: line.currency, amount: -line.amount } : null;
}

/**
 * Pair the credit payment lines a (non-planting) card import brought with the account's planted
 * payment lines, and let the bank's line replace each one-to-one match (see the module comment).
 * Records the confirmations; the replaced planted lines are the card-line funnel's plan to apply.
 */
export function replacePlantedPaymentLinesFromImport(
  accountId: number,
  statements: readonly CardCanonicalStatement[],
  batchKind: string
): PlantedPaymentReplacementPlan {
  const none = { result: EMPTY_MATCH, plan: EMPTY_CARD_LINE_PLAN };
  if (isPlantingBatchKind(batchKind)) return none;
  const planted = listPlantedPaymentLines(accountId);
  if (planted.length === 0) return none;
  const payments = statements.flatMap((st) => st.lines).map(importedPayment).filter((p): p is ImportedPayment => p != null);
  if (payments.length === 0) return none;

  const paired = pairPaymentsWithPlanted(payments, planted);
  const plantedOf = new Map(paired.pairs.map((x) => [x.payment, x.planted]));
  const ambiguousOf = new Map(paired.ambiguous.map((x) => [x.payment, x.planted]));

  const result: PlantedPaymentMatchResult = { replaced: [], confirmed_in_place: [], ambiguous: [], removed_from_date: null };
  const toReplace: { planted: PlantedPaymentRow; bankLineId: number; payment: ImportedPayment }[] = [];
  const toConfirm: { planted: PlantedPaymentRow; payment: ImportedPayment }[] = [];
  // In the import's order, so the report reads as the listing does.
  payments.forEach((p) => {
    const several = ambiguousOf.get(p);
    if (several) {
      result.ambiguous.push({
        bank_line_merchant: p.merchant,
        bank_line_date: p.date,
        amount: p.amount,
        currency: p.currency,
        planted_line_ids: several.map((r) => r.line_id),
      });
      return;
    }
    const row = plantedOf.get(p);
    if (!row) return;
    const stored = webPasteLineIdsForDedupeKey(accountId, p.line.document.dedupe_key ?? "");
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
  if (toReplace.length === 0 && toConfirm.length === 0) return { result, plan: EMPTY_CARD_LINE_PLAN };

  // Read the evidence date BEFORE the funnel deletes the planted lines, for the report.
  result.removed_from_date = earliestPlantedDate(toReplace.map((r) => r.planted.line_id));
  const unregister = db.prepare(`DELETE FROM cc_planted_payment_lines WHERE line_id = ?`);
  for (const r of toReplace) {
    confirmManualPaymentForPlanted(r.planted, r.payment.merchant);
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
  return {
    result,
    plan: {
      deleteLineIds: toReplace.map((r) => r.planted.line_id),
      carry: toReplace.map((r) => ({ fromLineId: r.planted.line_id, toLineId: r.bankLineId })),
    },
  };
}

function earliestPlantedDate(lineIds: readonly number[]): string | null {
  let out: string | null = null;
  const sel = db.prepare(`SELECT transaction_date FROM cc_statement_lines WHERE id = ?`);
  for (const id of lineIds) {
    const iso = normalizeTransactionDateIso((sel.get(id) as { transaction_date: string | null } | undefined)?.transaction_date ?? null);
    if (iso && (out == null || iso < out)) out = iso;
  }
  return out;
}

/**
 * A planted payment line and a statement's line for the same payment: a credit payment line in
 * the same currency, same amount, dated from the planted day to the window's end — whatever the
 * statement's wording.
 */
export function plantedPaymentMatchesStatementLine(
  planted: PlantedPaymentRow,
  stmt: { merchant: string | null; transaction_date: string | null; posting_date: string | null; amount: number | null; currency: string }
): boolean {
  if (!isPaymentLikeCreditMerchant(stmt.merchant)) return false;
  const raw = stmt.amount;
  if (raw == null || raw >= 0) return false;
  const iso = parseDdMmYyToIso(String(stmt.transaction_date ?? "")) ?? parseDdMmYyToIso(String(stmt.posting_date ?? ""));
  if (!iso) return false;
  return plantedPaymentFits(planted, { currency: stmt.currency, amount: -raw, date: iso });
}
