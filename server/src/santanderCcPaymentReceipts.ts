/**
 * Credit-card payment receipts (`card.payment_receipt`, decoded from Santander's receipt e-mails
 * by ingest — `ingest/src/santander/paymentReceipts.ts`) → the checking → card payment in the
 * ledger.
 *
 * The receipt mail («Pago Deuda Nacional TCR» for the CLP debt, «Comprobante Pago (abono) de la
 * deuda facturada en dolares» for the USD debt) is the bank's own confirmation of a card
 * payment: the pesos that left checking, the payment date, the card and — for the dollar abono —
 * the USD amount. Two things follow from it, depending on what the bank feed has delivered:
 *
 * - **The debit is not imported yet** (the daily «últimos movimientos» xlsx only arrives with the
 *   nightly bank session, so a morning payment has no bank row for hours): the `pago_tarjeta`
 *   transfer checking → card master is SYNTHESIZED from the receipt, dated the payment day, and the
 *   card's own credit line («PAGO» / «ABONO DE DIVISAS», exactly the row the card feed will list)
 *   is planted in the open web-paste bucket, so the checking balance, the deposits line and the
 *   owed walk all read the payment during the day. The bank's later listings confirm rather than
 *   duplicate: the xlsx/cartola debit dedupes as `superseded_by_transfer` (and stamps the
 *   confirmation row `santanderSyntheticCcPayments` records), the feed's credit line lands on the
 *   one-shot dedupe key. The mirror converter then finds no single-leg debit to pair.
 * - **The debit is already imported** at the next workday (a payment after the 14:00 cutoff is
 *   dated by every bank feed at the next workday): the debit is re-dated to the payment day.
 *
 * Either way the payment is dated when it happened, across a month boundary too; the bank's
 * posting day lives in `movement_bank_postings`, which is what the cartola checks read (a
 * payment on the 30th that the bank posts on the 1st counts in September's display and in
 * October's cartola). The re-dated row's NOTE keeps the bank's date as well — it is the xlsx
 * dedupe identity — and `prunePartialMovementsSupersededByCartola` carries the payment day and
 * the posting onto the official cartola row when the cartola replaces the partial.
 *
 * Matching is deliberately narrow (same spirit as ccPaymentMirrors): single-leg checking debit,
 * exact pesos, bank date inside the posting window of the payment date
 * (`bankDateMatchesTransferDate`).
 */
import type {
  CardListingLine,
  CardPaymentReceiptApplyDetails,
  CardPaymentReceiptPayload,
} from "nw-tracker-contracts";

import { importCcWebPasteLines } from "./accountImports.js";
import { invalidateAggregationForAccountDate, invalidateCcBillingDetail } from "./aggregationCache.js";
import { ddMmYyyyFromIso } from "./ccBillingCloses.js";
import { resolveMasterAccountIdForImportCardLast4 } from "./ccConsolidatedCards.js";
import { checkingAccountId } from "./checkingCartolaImport.js";
import { clearCheckingBalanceCache } from "./checkingCartolaBalances.js";
import { bankDateMatchesTransferDate } from "./checkingTransferLegReconcile.js";
import { db } from "./db.js";
import { MOVEMENT_CLP_LEG_SQL } from "./movementAmounts.js";
import { recordBankPosting } from "./movementBankPostings.js";
import { FLOW_KIND_PAGO_TARJETA } from "./movementFlowType.js";
import { webPasteLineFromCardListingLine } from "./cardListingLines.js";
import { creditCardMasterMetaForAccount } from "./ccWebPasteParse.js";
import {
  recordSyntheticCcPaymentTransfer,
  syntheticCcPaymentMovementIdForMessageId,
} from "./santanderSyntheticCcPayments.js";

export type ParsedPaymentReceipt = {
  kind: "clp" | "usd";
  /** Real payment date (YYYY-MM-DD) printed in the receipt. */
  paid_on: string;
  /** Pesos leaving checking — the CLP payment amount, or the USD payment's peso equivalent. */
  amount_clp: number;
  amount_usd: number | null;
  card_last4: string | null;
};

export type ReceiptApplyStatus = CardPaymentReceiptApplyDetails["status"];

export type ReceiptApplyResult = {
  receipt: ParsedPaymentReceipt;
  status: ReceiptApplyStatus;
  movement_id: number | null;
  detail: string;
};

type CandidateRow = { id: number; occurred_on: string };

/** "3476163" → "3.xxx.xxx"; "556.21" with 2 decimals → "556,21" — the feed's `Importe` conventions. */
function santanderImporteToken(amount: number, decimals: 0 | 2): string {
  const fixed = amount.toFixed(decimals);
  const [intPart, fraction] = fixed.split(".");
  const grouped = intPart!.replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  return fraction != null ? `${grouped},${fraction}` : grouped;
}

/**
 * The card's credit line for a receipt, exactly as the Santander feed will list the same payment
 * (merchant «PAGO» / «ABONO DE DIVISAS», dated the payment day, the feed's raw rendering), so the
 * feed row dedupes on the one-shot key. Mirrors `santanderMovementRowToLine` in
 * `ingest/src/santander/cardFeed.ts` for a `Comercio`-less `H` row; a test holds the two together.
 */
export function santanderReceiptCardLine(receipt: {
  paid_on: string;
  amount_clp: number;
  amount_usd: number | null;
}): CardListingLine {
  const isUsd = receipt.amount_usd != null;
  const merchant = isUsd ? "ABONO DE DIVISAS" : "PAGO";
  const importe = isUsd ? santanderImporteToken(receipt.amount_usd!, 2) : santanderImporteToken(receipt.amount_clp, 0);
  const magnitude = isUsd ? Number(receipt.amount_usd!.toFixed(2)) : Math.round(receipt.amount_clp);
  const fecha = ddMmYyyyFromIso(receipt.paid_on);
  return {
    date: receipt.paid_on,
    merchant,
    currency: isUsd ? "usd" : "clp",
    amount: -magnitude,
    raw_text: [fecha, merchant, merchant, importe].join(" "),
    // The feed lists every payment as the holder's.
    holder: "titular",
  };
}

/**
 * Write the payment the receipt describes when no bank row carries it yet: the checking → card
 * transfer (the migration-169 cross-currency shape for the dollar abono — CLP from-leg = the
 * receipt's peso equivalent, USD counter leg = the abono), its provenance row, and the card's own
 * credit line built through the SAME converter the feed import uses, so tomorrow's feed row is
 * byte-identical and dedupes on the one-shot key. All-or-nothing: a card that no master resolves
 * throws (registry/config data problem — never a guess).
 */
function synthesizeTransferFromReceipt(
  receipt: ParsedPaymentReceipt,
  messageId: string,
  checkingId: number
): { movement_id: number; card_account_id: number; card_line_planted: boolean } {
  const last4 = receipt.card_last4;
  if (!last4) throw new Error(`Receipt names no card — cannot synthesize its payment (${messageId})`);
  const cardAccountId = resolveMasterAccountIdForImportCardLast4(last4);
  if (cardAccountId == null) {
    throw new Error(`Receipt names card ·${last4} but no credit-card master resolves it (${messageId})`);
  }
  const isUsd = receipt.kind === "usd";
  if (isUsd && receipt.amount_usd == null) {
    throw new Error(`USD receipt without a USD amount — cannot synthesize its payment (${messageId})`);
  }
  const note = isUsd
    ? `Pago tarjeta espejo (divisas: comprobante ${receipt.paid_on} → abono tarjeta ·${last4} US$${receipt.amount_usd!.toFixed(2)})`
    : `Pago tarjeta espejo (comprobante ${receipt.paid_on} → abono tarjeta ·${last4})`;

  const write = db.transaction(() => {
    const r = db
      .prepare(
        `INSERT INTO movements (account_id, from_account_id, to_account_id, amount, currency, counter_amount, counter_currency, occurred_on, note, flow_kind)
         VALUES (NULL, ?, ?, ?, 'clp', ?, ?, ?, ?, ?)`
      )
      .run(
        checkingId,
        cardAccountId,
        receipt.amount_clp,
        isUsd ? receipt.amount_usd : null,
        isUsd ? "usd" : null,
        receipt.paid_on,
        note,
        FLOW_KIND_PAGO_TARJETA
      );
    const movementId = Number(r.lastInsertRowid);
    recordSyntheticCcPaymentTransfer(movementId, messageId, receipt.amount_clp, receipt.paid_on);

    const line = webPasteLineFromCardListingLine(
      creditCardMasterMetaForAccount(cardAccountId).cardGroup,
      santanderReceiptCardLine({
        paid_on: receipt.paid_on,
        amount_clp: receipt.amount_clp,
        amount_usd: isUsd ? receipt.amount_usd! : null,
      })
    );
    const planted = importCcWebPasteLines(cardAccountId, { lines: [line], errors: [] }, "cc_santander_receipt");
    return { movement_id: movementId, card_account_id: cardAccountId, card_line_planted: planted.inserted > 0 };
  });
  const out = write();

  clearCheckingBalanceCache(checkingId);
  invalidateAggregationForAccountDate(checkingId, receipt.paid_on);
  invalidateAggregationForAccountDate(cardAccountId, receipt.paid_on);
  invalidateCcBillingDetail(cardAccountId);
  return out;
}

/**
 * Apply one parsed receipt: synthesize the payment when the bank has not listed the debit yet,
 * otherwise move the matching checking debit's `occurred_on` to the payment date. Matches by
 * columns, not note text, so it works on `import:cartola-partial` rows and on official cartola
 * rows alike (receipt backlogs can arrive after the cartola).
 */
export function applyPaymentReceipt(receipt: ParsedPaymentReceipt, messageId: string): ReceiptApplyResult {
  const checkingId = checkingAccountId();
  const target = -receipt.amount_clp;

  // Already on the payment date (this run is a re-run, or the row was converted to a transfer
  // dated there by the CC payment mirror) → nothing to do.
  const already = db
    .prepare(
      `SELECT id FROM movements
       WHERE occurred_on = ?
         AND (
           (account_id = ? AND ROUND(${MOVEMENT_CLP_LEG_SQL}) = ROUND(?))
           OR (from_account_id = ? AND ROUND(${MOVEMENT_CLP_LEG_SQL}) = ROUND(?))
         )`
    )
    .all(receipt.paid_on, checkingId, target, checkingId, -target) as { id: number }[];
  if (already.length > 0) {
    return {
      receipt,
      status: "already_dated",
      movement_id: already[0]!.id,
      detail: `movement ${already[0]!.id} already dated ${receipt.paid_on}`,
    };
  }

  // Single-leg checking debits dated after the payment inside the posting window.
  const rows = db
    .prepare(
      `SELECT id, occurred_on FROM movements
       WHERE account_id = ? AND from_account_id IS NULL AND to_account_id IS NULL
         AND currency = 'clp' AND ROUND(amount) = ROUND(?)
         AND occurred_on > ?
       ORDER BY occurred_on`
    )
    .all(checkingId, target, receipt.paid_on) as CandidateRow[];
  const inWindow = rows.filter((r) => bankDateMatchesTransferDate(r.occurred_on, receipt.paid_on));
  if (inWindow.length === 0) {
    // This exact receipt already produced a transfer (the `already` query above misses it only
    // when that transfer was later moved) — never a second synthesis for one mail.
    const synthesizedId = syntheticCcPaymentMovementIdForMessageId(messageId);
    if (synthesizedId != null) {
      return {
        receipt,
        status: "already_dated",
        movement_id: synthesizedId,
        detail: `movement ${synthesizedId} was synthesized from this receipt`,
      };
    }
    const s = synthesizeTransferFromReceipt(receipt, messageId, checkingId);
    return {
      receipt,
      status: "synthesized",
      movement_id: s.movement_id,
      detail:
        `movement ${s.movement_id}: transfer synthesized from the receipt (${receipt.amount_clp} clp → account ${s.card_account_id}); ` +
        `card line ${s.card_line_planted ? "planted" : "already present"}`,
    };
  }
  if (inWindow.length > 1) {
    return {
      receipt,
      status: "ambiguous",
      movement_id: null,
      detail: `${inWindow.length} same-amount debits in the window — not re-dating any`,
    };
  }

  const match = inWindow[0]!;
  db.transaction(() => {
    db.prepare(`UPDATE movements SET occurred_on = ? WHERE id = ?`).run(receipt.paid_on, match.id);
    recordBankPosting(match.id, checkingId, match.occurred_on);
  })();
  clearCheckingBalanceCache(checkingId);
  invalidateAggregationForAccountDate(checkingId, receipt.paid_on);
  return {
    receipt,
    status: "redated",
    movement_id: match.id,
    detail: `movement ${match.id}: ${match.occurred_on} → ${receipt.paid_on}`,
  };
}

/**
 * Apply one ingested `card.payment_receipt` (`messageId` = its source ref, the receipt mail's
 * identity, which keys the synthesized payment so a resend never writes a second one).
 */
export function applyCardPaymentReceipt(
  payload: CardPaymentReceiptPayload,
  messageId: string
): CardPaymentReceiptApplyDetails {
  // The checking account, the card routing and the planted card line are Santander's.
  if (payload.issuer !== "santander") throw new Error(`No payment-receipt handling for issuer "${payload.issuer}"`);
  const applied = applyPaymentReceipt(
    {
      kind: payload.debt_currency,
      paid_on: payload.paid_on,
      amount_clp: payload.amount_clp,
      amount_usd: payload.amount_usd,
      card_last4: payload.card_last4,
    },
    messageId
  );
  return { status: applied.status, movement_id: applied.movement_id, detail: applied.detail };
}
