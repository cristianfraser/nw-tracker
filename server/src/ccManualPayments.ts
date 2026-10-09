/**
 * Card payments entered by hand (migration 232, `cc_manual_payments`): a payment made at a
 * branch, or from a dollar account, that no receipt mail announces.
 *
 * The same pipeline as a receipt (`santanderCcPaymentReceipts.ts`): the cash → card
 * `pago_tarjeta` transfer (written, or an existing one adopted) and the card's own credit line
 * planted in the open web-paste bucket, so the owed walk reads the payment the day it was made.
 * The bank's later listing replaces the planted line by amount, not wording
 * (`ccPlantedPayments.ts`), which stamps the payment confirmed; one still unconfirmed
 * {@link MANUAL_PAYMENT_CONFIRM_BUSINESS_DAYS} Chile business days after its day fails the
 * nightly `synthetic_cc_payments_check`.
 */
import { importCcWebPasteLines } from "./accountImports.js";
import { invalidateAggregationForAccountDate, invalidateCcBillingDetail } from "./aggregationCache.js";
import { ddMmYyyyFromIso } from "./ccBillingCloses.js";
import { confirmManualPaymentForPlanted, recordPlantedPaymentLine } from "./ccPlantedPayments.js";
import { creditCardMasterMetaForAccount, webPasteLineDedupeKey } from "./ccWebPasteParse.js";
import { webPasteLineFromCardListingLine } from "./cardListingLines.js";
import { clearCheckingBalanceCache } from "./checkingCartolaBalances.js";
import { db } from "./db.js";
import { nextChileBusinessDayYmd } from "./marketHolidays.js";
import { FLOW_KIND_PAGO_TARJETA } from "./movementFlowType.js";
import { isUsdCashAccount } from "./movementTransfer.js";

export const MANUAL_PAYMENT_CONFIRM_BUSINESS_DAYS = 5;

export type ManualCardPaymentInput = {
  from_account_id: number;
  card_account_id: number;
  amount: number;
  currency: "clp" | "usd";
  /** YYYY-MM-DD, the day the money left. */
  paid_on: string;
  note?: string | null;
  /** Adopt this `pago_tarjeta` transfer instead of writing one. */
  existing_transfer_movement_id?: number | null;
};

export type ManualCardPaymentResult = {
  status: "recorded" | "already_recorded";
  manual_payment_id: number;
  transfer_movement_id: number;
  /** What happened to the card's credit line. */
  card_line: "planted" | "already_planted" | "bank_line_on_file" | "fuzzy_twin_on_file";
  planted_line_id: number | null;
  detail: string;
};

type MovementRow = {
  id: number;
  account_id: number | null;
  from_account_id: number | null;
  to_account_id: number | null;
  amount: number;
  currency: string;
  occurred_on: string;
  flow_kind: string | null;
};

function sameMoney(currency: "clp" | "usd", a: number, b: number): boolean {
  return currency === "usd" ? Math.round(a * 100) === Math.round(b * 100) : Math.round(a) === Math.round(b);
}

function existingManualPayment(transferId: number): { id: number } | undefined {
  return db.prepare(`SELECT id FROM cc_manual_payments WHERE transfer_movement_id = ?`).get(transferId) as
    | { id: number }
    | undefined;
}

/** The card's credit line for the payment, as a debt-positive listing line (a credit: negative). */
function manualPaymentListingLine(input: ManualCardPaymentInput, magnitude: number) {
  const merchant = input.currency === "usd" ? "ABONO DE DIVISAS" : "PAGO";
  return {
    date: input.paid_on,
    merchant,
    currency: input.currency,
    amount: -magnitude,
    raw_text: `${ddMmYyyyFromIso(input.paid_on)} ${merchant} (pago ingresado a mano)`,
    holder: "titular" as const,
  };
}

/**
 * Record a card payment entered by hand: the transfer (written or adopted), its row and the
 * card's planted credit line. Idempotent: a second call for the same transfer — or with the same
 * accounts, currency, amount and day — changes nothing.
 */
export function recordManualCardPayment(input: ManualCardPaymentInput): ManualCardPaymentResult {
  const { from_account_id: fromId, card_account_id: cardId, currency, paid_on: paidOn } = input;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(paidOn)) throw new Error(`paid_on must be YYYY-MM-DD, got ${paidOn}`);
  if (!(input.amount > 0)) throw new Error(`amount must be positive, got ${input.amount}`);
  if (currency !== "clp" && currency !== "usd") throw new Error(`currency must be clp or usd, got ${currency}`);
  const magnitude = currency === "usd" ? Number(input.amount.toFixed(2)) : Math.round(input.amount);
  if (fromId === cardId) throw new Error("A card payment needs a source account other than the card");
  const cardGroup = creditCardMasterMetaForAccount(cardId).cardGroup;
  const fromIsUsd = isUsdCashAccount(fromId);
  if ((currency === "usd") !== fromIsUsd) {
    throw new Error(
      `Account ${fromId} does not hold ${currency.toUpperCase()} — a cross-currency card payment is not supported here`
    );
  }

  // Idempotency: the same transfer, or a transfer this function already wrote for the same payment.
  const prior =
    input.existing_transfer_movement_id != null
      ? existingManualPayment(input.existing_transfer_movement_id)
      : (db
          .prepare(
            `SELECT p.id, p.transfer_movement_id FROM cc_manual_payments p
             JOIN movements m ON m.id = p.transfer_movement_id
             WHERE p.card_account_id = ? AND m.from_account_id = ? AND p.currency = ? AND ABS(p.amount - ?) < 0.005
               AND p.paid_on = ?`
          )
          .get(cardId, fromId, currency, magnitude, paidOn) as { id: number } | undefined);
  if (prior) {
    const row = db
      .prepare(`SELECT id, transfer_movement_id, planted_line_id FROM cc_manual_payments WHERE id = ?`)
      .get(prior.id) as { id: number; transfer_movement_id: number; planted_line_id: number | null };
    return {
      status: "already_recorded",
      manual_payment_id: row.id,
      transfer_movement_id: row.transfer_movement_id,
      card_line: "already_planted",
      planted_line_id: row.planted_line_id,
      detail: `manual payment ${row.id} (movement ${row.transfer_movement_id}) is already recorded`,
    };
  }

  const write = db.transaction((): ManualCardPaymentResult => {
    let transferId: number;
    if (input.existing_transfer_movement_id != null) {
      const m = db
        .prepare(
          `SELECT id, account_id, from_account_id, to_account_id, amount, currency, occurred_on, flow_kind
           FROM movements WHERE id = ?`
        )
        .get(input.existing_transfer_movement_id) as MovementRow | undefined;
      if (!m) throw new Error(`Movement ${input.existing_transfer_movement_id} does not exist`);
      const problems: string[] = [];
      if (m.account_id != null || m.from_account_id !== fromId || m.to_account_id !== cardId) {
        problems.push(`not a transfer ${fromId} → ${cardId}`);
      }
      if (m.flow_kind !== FLOW_KIND_PAGO_TARJETA) problems.push(`flow_kind ${m.flow_kind ?? "null"}, not pago_tarjeta`);
      if (m.currency !== currency || !sameMoney(currency, Number(m.amount), magnitude)) {
        problems.push(`amount ${m.amount} ${m.currency}, not ${magnitude} ${currency}`);
      }
      if (m.occurred_on !== paidOn) problems.push(`dated ${m.occurred_on}, not ${paidOn}`);
      if (problems.length > 0) {
        throw new Error(`Movement ${m.id} cannot be adopted as this card payment: ${problems.join("; ")}`);
      }
      transferId = m.id;
    } else {
      const note =
        input.note?.trim() ||
        `Pago tarjeta ingresado a mano (${paidOn} → tarjeta ·${creditCardMasterMetaForAccount(cardId).cardLast4})`;
      const r = db
        .prepare(
          `INSERT INTO movements (account_id, from_account_id, to_account_id, amount, currency, occurred_on, note, flow_kind)
           VALUES (NULL, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(fromId, cardId, magnitude, currency, paidOn, note, FLOW_KIND_PAGO_TARJETA);
      transferId = Number(r.lastInsertRowid);
    }
    const ins = db
      .prepare(
        `INSERT INTO cc_manual_payments (transfer_movement_id, card_account_id, currency, amount, paid_on)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run(transferId, cardId, currency, magnitude, paidOn);
    const manualId = Number(ins.lastInsertRowid);

    const line = webPasteLineFromCardListingLine(cardGroup, manualPaymentListingLine(input, magnitude));
    const imported = importCcWebPasteLines(cardId, { lines: [line], errors: [] }, "cc_manual_payment");
    const payment = { currency, amount: magnitude, paid_on: paidOn };
    const rec = recordPlantedPaymentLine(
      cardId,
      "cc_manual_payment",
      payment,
      webPasteLineDedupeKey(cardGroup, line),
      imported.inserted > 0
    );
    const plantedRow = { line_id: 0, account_id: cardId, source: "cc_manual_payment" as const, ...payment };
    let cardLine: ManualCardPaymentResult["card_line"];
    let plantedLineId: number | null = null;
    if (rec.kind === "planted" || rec.kind === "already_planted") {
      cardLine = rec.kind;
      plantedLineId = rec.line_id;
    } else if (rec.kind === "bank_line_on_file") {
      // The bank already lists this exact line: the payment is on the card.
      cardLine = "bank_line_on_file";
      confirmManualPaymentForPlanted(plantedRow, rec.merchant);
    } else {
      // Skipped as the fuzzy twin of a same-day, same-amount line already on file.
      cardLine = "fuzzy_twin_on_file";
      confirmManualPaymentForPlanted(plantedRow, "(fuzzy twin on file)");
    }
    db.prepare(`UPDATE cc_manual_payments SET planted_line_id = ? WHERE id = ?`).run(plantedLineId, manualId);
    return {
      status: "recorded",
      manual_payment_id: manualId,
      transfer_movement_id: transferId,
      card_line: cardLine,
      planted_line_id: plantedLineId,
      detail:
        `manual payment ${manualId}: ${input.existing_transfer_movement_id != null ? "adopted" : "wrote"} movement ` +
        `${transferId} (${magnitude} ${currency} ${fromId} → card ${cardId}, ${paidOn}); card line ${cardLine}` +
        (plantedLineId != null ? ` (line ${plantedLineId})` : ""),
    };
  });
  const out = write();

  clearCheckingBalanceCache(fromId);
  invalidateAggregationForAccountDate(fromId, paidOn);
  invalidateAggregationForAccountDate(cardId, paidOn);
  invalidateCcBillingDetail(cardId);
  return out;
}

export type OverdueManualCardPayment = {
  manual_payment_id: number;
  transfer_movement_id: number;
  card_account_id: number;
  currency: "clp" | "usd";
  amount: number;
  paid_on: string;
  /** Null only if the deadline walk failed — treated as overdue rather than hidden. */
  deadline: string | null;
};

export function manualPaymentConfirmationDeadlineYmd(paidOnYmd: string): string | null {
  let cur: string | null = paidOnYmd;
  for (let i = 0; i < MANUAL_PAYMENT_CONFIRM_BUSINESS_DAYS; i++) {
    cur = nextChileBusinessDayYmd(cur);
    if (cur == null) return null;
  }
  return cur;
}

/** Manual card payments no bank listing has confirmed by their deadline. */
export function listOverdueUnconfirmedManualCardPayments(todayYmd: string): OverdueManualCardPayment[] {
  const rows = db
    .prepare(
      `SELECT id AS manual_payment_id, transfer_movement_id, card_account_id, currency, amount, paid_on
       FROM cc_manual_payments WHERE confirmed_on IS NULL ORDER BY paid_on, id`
    )
    .all() as Omit<OverdueManualCardPayment, "deadline">[];
  return rows
    .map((r) => ({ ...r, deadline: manualPaymentConfirmationDeadlineYmd(r.paid_on) }))
    .filter((r) => r.deadline == null || todayYmd > r.deadline);
}
