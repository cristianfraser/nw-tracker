/**
 * Import Lider BCI «últimos movimientos» CSVs dropped in `cfraser/inbox/` by the scheduled fetcher.
 *
 * Same shape as the Santander movements importer: the file is adapted to web-paste lines and
 * pushed through `importCcWebPasteLines`, so a daily fetch of an overlapping window is safe —
 * repeats carry the `ccOneShotDedupeKey` a manual paste would produce and skip as duplicates.
 *
 * The card is resolved from the registry's `lider_filename_last4s` rather than hardcoded, and the
 * import refuses to guess when that list does not name exactly one card.
 */
import fs from "node:fs";
import path from "node:path";
import { importCcWebPasteLines } from "./accountImports.js";
import { ccCardRegistry } from "./ccCardRegistry.js";
import { resolveMasterAccountIdForImportCardLast4 } from "./ccConsolidatedCards.js";
import { merchantsMatchForCrossDedupe } from "./ccCrossImportDedupe.js";
import { parseDdMmYyToIso } from "./ccInstallmentPayBy.js";
import { readCommaCsvRecords } from "./ccParsedCommaCsv.js";
import { webPasteAmountClpForDb } from "./ccPaymentLines.js";
import { creditCardMasterMetaForAccount } from "./ccWebPasteParse.js";
import { resolveCfraserCsvDir, resolveCfraserInboxDir } from "./cfraserPaths.js";
import { db } from "./db.js";
import { liderMovementsToWebPasteLines } from "./liderCardMovements.js";
import type { CcWebPasteLine } from "./ccWebPasteParse.js";

/** `lider-bci-movimientos-2026-08-05.csv` — the scheduled fetcher's filename. */
const LIDER_MOVEMENTS_FILE_RE = /^lider[-_]?bci[-_]movimientos[-_].*\.csv$/i;

export function isLiderMovementsFilename(name: string): boolean {
  return LIDER_MOVEMENTS_FILE_RE.test(String(name ?? "").trim());
}

/** Staged files in the inbox, oldest first, so a backlog imports in capture order. */
export function listLiderMovementInboxFiles(dir = resolveCfraserInboxDir()): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter(isLiderMovementsFilename)
    .sort()
    .map((name) => path.join(dir, name));
}

export function liderMovementsArchiveDir(cfraserDir = resolveCfraserCsvDir()): string {
  return path.join(cfraserDir, "lider-movements", "imported");
}

/**
 * The BCI Lider master account. The registry lists the card last4s that appear in Lider
 * filenames; exactly one must resolve to a master, otherwise the import cannot know which card a
 * movements file belongs to.
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

export type LiderMovementsParsedFile = {
  file: string;
  accountId: number;
  lines: CcWebPasteLine[];
};

export function parseLiderMovementsFile(file: string): LiderMovementsParsedFile {
  const rows = readCommaCsvRecords(file);
  if (rows.length === 0) throw new Error(`Lider movements CSV has no data rows: ${file}`);
  return {
    file: path.basename(file),
    accountId: liderMasterAccountId(),
    lines: liderMovementsToWebPasteLines(rows),
  };
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
  if (!meta) throw new Error(`Account ${accountId} is not a credit card master`);
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

export type LiderMovementsImportResult = {
  file: string;
  account_id: number;
  lines_parsed: number;
  inserted: number;
  skipped_duplicate: number;
  /** One-shot rows recognised as an existing installment plan's principal or cuota. */
  skipped_installment_overlap: number;
  /** Rows an existing ledger line already covers for that day+amount under another merchant. */
  skipped_same_day_amount: { date: string; amount_clp: number; feed_merchant: string; ledger_merchant: string | null }[];
  batch_id: number | null;
  archived_to: string | null;
};

/**
 * Import one file and archive it.
 *
 * Archiving rather than deleting keeps the raw feed: it is the only record of what the bank
 * showed on a given day, and re-importing it is idempotent if that is ever needed.
 */
export function importLiderMovementsFile(
  file: string,
  opts?: { archiveDir?: string; dryRun?: boolean }
): LiderMovementsImportResult {
  const parsed = parseLiderMovementsFile(file);
  const { importable, sameDayAmount } = classifyLiderLines(parsed.accountId, parsed.lines);
  const skipped_same_day_amount = sameDayAmount.map((s) => ({
    date: s.line.transaction_date,
    amount_clp: s.amount_clp_db,
    feed_merchant: s.line.merchant,
    ledger_merchant: s.same_day_amount_match?.merchant ?? null,
  }));

  if (opts?.dryRun) {
    return {
      file: parsed.file,
      account_id: parsed.accountId,
      lines_parsed: parsed.lines.length,
      inserted: 0,
      skipped_duplicate: 0,
      skipped_installment_overlap: 0,
      skipped_same_day_amount,
      batch_id: null,
      archived_to: null,
    };
  }

  const result = importCcWebPasteLines(
    parsed.accountId,
    { lines: importable, errors: [] },
    "cc_lider_fetch"
  );

  const archiveDir = opts?.archiveDir ?? liderMovementsArchiveDir();
  fs.mkdirSync(archiveDir, { recursive: true });
  const archivedTo = path.join(archiveDir, path.basename(file));
  if (fs.existsSync(archivedTo)) fs.unlinkSync(archivedTo);
  fs.renameSync(file, archivedTo);

  return {
    file: parsed.file,
    account_id: parsed.accountId,
    lines_parsed: result.lines_parsed,
    inserted: result.inserted,
    skipped_duplicate: result.skipped_duplicate,
    skipped_installment_overlap:
      result.skipped_flows?.filter((f) => f.reason === "installment_overlap").length ?? 0,
    skipped_same_day_amount,
    batch_id: result.batch_id,
    archived_to: archivedTo,
  };
}

/** Import every staged inbox file (no-op when none are present). */
export function importStagedLiderMovements(opts?: {
  inboxDir?: string;
  archiveDir?: string;
  dryRun?: boolean;
}): LiderMovementsImportResult[] {
  const files = listLiderMovementInboxFiles(opts?.inboxDir);
  return files.map((file) =>
    importLiderMovementsFile(file, { archiveDir: opts?.archiveDir, dryRun: opts?.dryRun })
  );
}
