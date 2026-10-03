/**
 * The Lider BCI card's own lines, as the grocery receipts (`storeReceiptApply.ts`) write them: the
 * card's master account from the registry, and the same-day-same-amount check that keeps a
 * receipt's line from duplicating a purchase the ledger already holds under another merchant
 * name. (It was the «últimos movimientos» CSV importer until that scheduled export retired on
 * 2026-08-07; the importer went on 2026-10-03.)
 */
import { ccCardRegistry } from "./ccCardRegistry.js";
import { resolveMasterAccountIdForImportCardLast4 } from "./ccConsolidatedCards.js";
import { merchantsMatchForCrossDedupe } from "./ccCrossImportDedupe.js";
import { parseDdMmYyToIso } from "./ccInstallmentPayBy.js";
import { webPasteAmountClpForDb } from "./ccPaymentLines.js";
import { creditCardMasterMetaForAccount } from "./ccWebPasteParse.js";
import { db } from "./db.js";
import type { CcWebPasteLine } from "./ccWebPasteParse.js";

/**
 * The BCI Lider master account. The registry lists the Lider card's last4s
 * (`lider_filename_last4s`); exactly one must resolve to a master, otherwise a receipt cannot know
 * which card its line belongs to.
 */
export function liderMasterAccountId(): number {
  const last4s = [...new Set(ccCardRegistry().lider_filename_last4s.map((l) => String(l).trim()))].filter(
    Boolean
  );
  const resolved = last4s
    .map((last4) => ({ last4, accountId: resolveMasterAccountIdForImportCardLast4(last4) }))
    .filter((r): r is { last4: string; accountId: number } => r.accountId != null);
  if (resolved.length !== 1) {
    throw new Error(
      `Cannot resolve the Lider master account: registry lider_filename_last4s ` +
        `[${last4s.join(", ")}] resolved to ${resolved.length} master account(s) ` +
        `(${resolved.map((r) => `·${r.last4}→${r.accountId}`).join(", ") || "none"})`
    );
  }
  return resolved[0]!.accountId;
}

const dbOneShotLinesForAccount = db.prepare(
  `SELECT l.merchant, l.transaction_date, l.posting_date, l.amount_clp
   FROM cc_statement_lines l
   JOIN cc_statements s ON s.id = l.statement_id
   WHERE s.account_id = ? AND l.installment_flag = 0 AND l.amount_clp IS NOT NULL`
);

/**
 * A ledger line for the same day and the exact same signed amount, whatever its merchant text.
 *
 * The regular dedupe keys off (merchant, amount, date), which is right when both sides render the
 * merchant the same way — and the fetched CSV does match the PDF convention (`EXPRESS LYON,
 * SANTIAGO` vs the statement's `EXPRESS LYON, SANTIAGO (T)`, whose suffix the BCI normalizer
 * strips). What it cannot match is a hand-pasted line for the same purchase copied from a view
 * that names the merchant differently: the 2026-07-30 2x.xxx charge sits in the open bucket as
 * «SUPERMERCADO PLAZA LYON LTDA.» while this feed calls it «EXPRESS LYON, SANTIAGO».
 *
 * Same card, same day, same exact peso amount is overwhelmingly the same purchase, so the feed
 * yields to whatever is already recorded. The cost of being wrong is bounded and self-correcting:
 * these lines live in the open web-paste bucket, which the month's PDF statement supersedes
 * wholesale (`reconcileOpenWebPasteAfterPdfImports`) — and the PDF, not this feed, is what the
 * facturación is ultimately reconciled against.
 */
export function findLedgerLineSameDayAndAmount(
  accountId: number,
  dateIso: string,
  amountClpForDb: number
): { merchant: string | null } | null {
  const rows = dbOneShotLinesForAccount.all(accountId) as {
    merchant: string | null;
    transaction_date: string | null;
    posting_date: string | null;
    amount_clp: number;
  }[];
  for (const row of rows) {
    if (row.amount_clp !== amountClpForDb) continue;
    const rowIso =
      parseDdMmYyToIso(String(row.transaction_date ?? "")) ??
      parseDdMmYyToIso(String(row.posting_date ?? ""));
    if (rowIso === dateIso) return { merchant: row.merchant };
  }
  return null;
}

export type LiderLineClassification = {
  line: CcWebPasteLine;
  /** Signed amount in the DB's convention (charges positive, payments negative). */
  amount_clp_db: number;
  /** Set when an existing ledger line already covers this day+amount under another merchant. */
  same_day_amount_match: { merchant: string | null } | null;
};

/**
 * Split parsed lines into the ones to import and the ones an existing ledger line already covers
 * under a different merchant rendering. Exact-key duplicates and installment overlaps are NOT
 * filtered here — the shared import path recognises those and records them as skips, which is
 * better evidence than dropping them silently.
 */
export function classifyLiderLines(
  accountId: number,
  lines: readonly CcWebPasteLine[]
): { importable: CcWebPasteLine[]; sameDayAmount: LiderLineClassification[] } {
  const meta = creditCardMasterMetaForAccount(accountId);
  const importable: CcWebPasteLine[] = [];
  const sameDayAmount: LiderLineClassification[] = [];
  for (const line of lines) {
    const amountDb = webPasteAmountClpForDb(line.amount_clp, line.merchant, meta.cardGroup);
    const match = findLedgerLineSameDayAndAmount(accountId, line.transaction_date, amountDb);
    // A merchant the normal dedupe already matches needs no special handling — let the shared
    // path skip it as a duplicate so the reason shows up in the batch log.
    if (match && !merchantsMatchForCrossDedupe(match.merchant, line.merchant)) {
      sameDayAmount.push({ line, amount_clp_db: amountDb, same_day_amount_match: match });
      continue;
    }
    importable.push(line);
  }
  return { importable, sameDayAmount };
}
