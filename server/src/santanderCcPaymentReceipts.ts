/**
 * Santander credit-card payment receipt e-mails → checking movement re-dating.
 *
 * A card payment made after the bank's 14:00 cutoff is dated by every bank feed (the daily
 * «últimos movimientos» xlsx AND the monthly cartola) at the NEXT WORKDAY — but the receipt
 * mail («Pago Deuda Nacional TCR» for the CLP debt, «Comprobante Pago (abono) de la deuda
 * facturada en dolares» for the USD debt) states the real payment date, when the money and the
 * card's abono actually moved. This importer re-dates the matching checking debit to that day.
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

import { invalidateAggregationForAccountDate } from "./aggregationCache.js";
import { checkingAccountId } from "./checkingCartolaImport.js";
import { clearCheckingBalanceCache } from "./checkingCartolaBalances.js";
import { bankDateMatchesTransferDate } from "./checkingTransferLegReconcile.js";
import { db } from "./db.js";
import { MOVEMENT_CLP_LEG_SQL } from "./movementAmounts.js";
import { resolveCfraserCsvDir } from "./cfraserPaths.js";

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

/**
 * Apply one parsed receipt: move the matching checking debit's `occurred_on` to the payment
 * date. Matches by columns, not note text, so it works on `import:cartola-partial` rows and on
 * official cartola rows alike (receipt backlogs can arrive after the cartola).
 */
export function applyPaymentReceipt(receipt: ParsedPaymentReceipt): Omit<ReceiptApplyResult, "file"> {
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
    return {
      receipt,
      status: "waiting_for_movement",
      movement_id: null,
      detail: "no matching checking debit yet — will retry once the bank feed delivers it",
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
 * Process every staged receipt file. Resolved receipts (re-dated, already dated, or straddle)
 * are archived to `processed/`; `waiting_for_movement` and `ambiguous` files stay staged so the
 * next run retries them. Unparsable receipts throw.
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
    const applied = applyPaymentReceipt(receipt);
    results.push({ file: path.basename(file), ...applied });
    if (
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
