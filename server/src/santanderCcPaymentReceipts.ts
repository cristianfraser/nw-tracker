/**
 * Santander credit-card payment receipt e-mails → the checking → card payment in the ledger.
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
 * The movement's NOTE keeps the bank's date — it is the dedupe identity against the bank's own
 * frame (the daily xlsx re-lists the row under the bank date, and the cartola prints it there
 * too), so only `occurred_on` moves. `prunePartialMovementsSupersededByCartola` carries a
 * re-dated `occurred_on` onto the official cartola row when the cartola later replaces the
 * partial, so the correction survives the monthly import.
 *
 * Matching is deliberately narrow (same spirit as ccPaymentMirrors): single-leg checking debit,
 * exact pesos, bank date inside the posting window of the payment date
 * (`bankDateMatchesTransferDate`), same calendar month — a month-straddling payment keeps the
 * bank date, because a movement dated into the earlier month would sit in a cartola period whose
 * saldo_final excludes it and corrupt the checking anchor derivation.
 */
import fs from "node:fs";
import path from "node:path";

import { importCcWebPasteLines } from "./accountImports.js";
import { invalidateAggregationForAccountDate, invalidateCcBillingDetail } from "./aggregationCache.js";
import { ddMmYyyyFromIso } from "./ccBillingCloses.js";
import { resolveMasterAccountIdForImportCardLast4 } from "./ccConsolidatedCards.js";
import { checkingAccountId } from "./checkingCartolaImport.js";
import { clearCheckingBalanceCache } from "./checkingCartolaBalances.js";
import { bankDateMatchesTransferDate } from "./checkingTransferLegReconcile.js";
import { db } from "./db.js";
import { nextChileBusinessDayYmd } from "./marketHolidays.js";
import { MOVEMENT_CLP_LEG_SQL } from "./movementAmounts.js";
import { FLOW_KIND_PAGO_TARJETA } from "./movementFlowType.js";
import { resolveCfraserCsvDir } from "./cfraserPaths.js";
import { santanderMovementRowToWebPasteLine } from "./santanderCardMovements.js";
import {
  recordSyntheticCcPaymentTransfer,
  syntheticCcPaymentMovementIdForMessageId,
} from "./santanderSyntheticCcPayments.js";

export type StagedPaymentReceipt = {
  message_id: string;
  subject: string;
  /** ISO datetime of the mail. */
  date: string;
  /** Flattened body text staged by the scraper. */
  text: string;
};

export type ParsedPaymentReceipt = {
  kind: "clp" | "usd";
  /** Real payment date (YYYY-MM-DD) printed in the receipt. */
  paid_on: string;
  /** Pesos leaving checking — the CLP payment amount, or the USD payment's peso equivalent. */
  amount_clp: number;
  amount_usd: number | null;
  card_last4: string | null;
};

export function receiptsStagingDir(cfraserDir = resolveCfraserCsvDir()): string {
  return path.join(cfraserDir, "santander-payment-receipts");
}

export function listStagedReceiptFiles(dir = receiptsStagingDir()): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((n) => /^receipt-.*\.json$/i.test(n))
    .sort()
    .map((n) => path.join(dir, n));
}

function ymdFromDdMmYyyy(d: string, m: string, y: string): string {
  return `${y}-${m.padStart(2, "0")}-${d.padStart(2, "0")}`;
}

/** "9xx.xxx" → 923815 (Chilean integer pesos; receipts carry no decimals on CLP). */
function parseReceiptPesos(raw: string): number {
  const n = Number(String(raw).replace(/\./g, ""));
  if (!Number.isFinite(n) || n <= 0) throw new Error(`Unparseable pesos amount "${raw}"`);
  return n;
}

/**
 * Parse a staged receipt. Throws on a receipt that classifies but does not parse — a template
 * change must surface as a failed step, not as a silently undated payment.
 */
export function parsePaymentReceipt(staged: StagedPaymentReceipt): ParsedPaymentReceipt {
  const text = staged.text.replace(/\s+/g, " ");
  const date = /con fecha (\d{2})[/-](\d{2})[/-](\d{4})/i.exec(text);
  if (!date) throw new Error(`Receipt without a payment date: "${staged.subject}" (${staged.message_id})`);
  const paid_on = ymdFromDdMmYyyy(date[1]!, date[2]!, date[3]!);
  const card = /\*[* ]*(\d{4})\b/.exec(text);
  const card_last4 = card ? card[1]! : null;

  const clp = /Monto del pago:\s*\$?\s*([\d.]+)/i.exec(text);
  if (clp) {
    return { kind: "clp", paid_on, amount_clp: parseReceiptPesos(clp[1]!), amount_usd: null, card_last4 };
  }

  const pesos = /Equivalente en pesos\s*\$\s*([\d.]+)/i.exec(text);
  const usd = /Monto pagado \(abono\)\s*USD\s*([\d.,]+)/i.exec(text);
  if (pesos) {
    const amount_usd = usd ? Number(usd[1]!.replace(/\./g, "").replace(",", ".")) : null;
    return { kind: "usd", paid_on, amount_clp: parseReceiptPesos(pesos[1]!), amount_usd, card_last4 };
  }

  throw new Error(`Receipt without a recognisable amount: "${staged.subject}" (${staged.message_id})`);
}

export type ReceiptApplyStatus =
  | "redated"
  | "already_dated"
  | "month_straddle_keeps_bank_date"
  | "synthesized"
  | "waiting_for_movement"
  | "ambiguous";

export type ReceiptApplyResult = {
  file: string;
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

    const line = santanderMovementRowToWebPasteLine(
      {
        Fecha: ddMmYyyyFromIso(receipt.paid_on),
        Descripcion: isUsd ? "ABONO DE DIVISAS" : "PAGO",
        Comercio: null,
        Importe: isUsd ? santanderImporteToken(receipt.amount_usd!, 2) : santanderImporteToken(receipt.amount_clp, 0),
        DescripcionRubro: null,
        Ciudad: null,
        TipoBen: "Titular",
        IndicadorDebeHaber: "H",
      },
      isUsd ? "usd" : "clp"
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
export function applyPaymentReceipt(
  receipt: ParsedPaymentReceipt,
  messageId: string
): Omit<ReceiptApplyResult, "file"> {
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
    // When the bank could post the debit NEXT month (the payment date's next business day
    // crosses the boundary), a transfer dated this month would sit in a cartola period whose
    // saldo_final still includes the money, corrupting the checking-anchor derivation — the same
    // reason the re-date path keeps the bank date across a month boundary. Those payments wait
    // for the bank row, as before.
    const nextBusinessDay = nextChileBusinessDayYmd(receipt.paid_on);
    if (nextBusinessDay == null || nextBusinessDay.slice(0, 7) !== receipt.paid_on.slice(0, 7)) {
      return {
        receipt,
        status: "waiting_for_movement",
        movement_id: null,
        detail: "the bank may post this debit next month — waiting for its listing instead of synthesizing (checking-anchor rule)",
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
  if (match.occurred_on.slice(0, 7) !== receipt.paid_on.slice(0, 7)) {
    // Cartola periods are calendar months; pulling the debit into the earlier month would break
    // the checking anchor derivation, so the bank's posting date stands.
    return {
      receipt,
      status: "month_straddle_keeps_bank_date",
      movement_id: match.id,
      detail: `payment ${receipt.paid_on} posted ${match.occurred_on} across a month boundary — bank date kept`,
    };
  }

  db.prepare(`UPDATE movements SET occurred_on = ? WHERE id = ?`).run(receipt.paid_on, match.id);
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
 * Process every staged receipt file. Resolved receipts (synthesized, re-dated, already dated, or
 * straddle) are archived to `processed/`; `waiting_for_movement` and `ambiguous` files stay
 * staged so the next run retries them. Unparsable receipts throw.
 */
export function importStagedPaymentReceipts(opts?: {
  dir?: string;
  dryRun?: boolean;
}): ReceiptApplyResult[] {
  const dir = opts?.dir ?? receiptsStagingDir();
  const results: ReceiptApplyResult[] = [];
  for (const file of listStagedReceiptFiles(dir)) {
    const staged = JSON.parse(fs.readFileSync(file, "utf8")) as StagedPaymentReceipt;
    const receipt = parsePaymentReceipt(staged);
    if (opts?.dryRun) {
      results.push({ file: path.basename(file), receipt, status: "waiting_for_movement", movement_id: null, detail: "dry run" });
      continue;
    }
    const applied = applyPaymentReceipt(receipt, staged.message_id);
    results.push({ file: path.basename(file), ...applied });
    if (
      applied.status === "synthesized" ||
      applied.status === "redated" ||
      applied.status === "already_dated" ||
      applied.status === "month_straddle_keeps_bank_date"
    ) {
      const processedDir = path.join(dir, "processed");
      fs.mkdirSync(processedDir, { recursive: true });
      fs.renameSync(file, path.join(processedDir, path.basename(file)));
    }
  }
  return results;
}
