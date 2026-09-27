import fs from "node:fs";
import path from "node:path";
import { resolveCfraserCsvDir } from "./cfraserPaths.js";
import { importCcWebPasteLines } from "./accountImports.js";
import { masterAccountIdForSantanderAccount } from "./santanderAccountMap.js";
import {
  santanderFeedClosesByAccount,
  santanderMovementsByAccount,
  type SantanderMovementsFile,
} from "./santanderCardMovements.js";
import {
  assertFeedClosesMatchStatements,
  recordFeedBillingClose,
} from "./ccBillingCloses.js";
import { moveOpenBucketLinesByDedupeKey } from "./ccOpenWebPasteRepair.js";
import { creditCardMasterMetaForAccount, webPasteLineDedupeKey } from "./ccWebPasteParse.js";
import { addCalendarMonths } from "./ccYearMonth.js";
import { db } from "./db.js";
import { recomputeCcBillingMonthBalances } from "./ccBillingBalances.js";
import { upsertCreditCardValuationsFromLedger } from "./ccCreditCardValuations.js";
import { billingDetailCacheForAccount } from "./ccBillingDetailCache.js";
import {
  createPlansForFeedCuotaPurchases,
  tagFeedCuotaPurchaseLines,
  type CcFeedPlanCreated,
} from "./ccFeedCuotaPurchases.js";
import { mirrorOpenBucketsToFeed, type CcFeedMirrorResult } from "./ccFeedMirror.js";
import type { CcInstallmentFirstDueNudge } from "./ccWebPasteInstallmentNudge.js";
import {
  parseBankCupoCapture,
  recordBankCupoCapture,
  type BankCupoCaptureResult,
} from "./santanderBankCupo.js";

/** Where `scraper/` stages fetched movement files. */
export function resolveSantanderMovementsDir(): string {
  return path.join(resolveCfraserCsvDir(), "santander-movements");
}

/** Fetched files, oldest first, so a backlog imports in the order it was captured. */
export function listSantanderMovementFiles(dir = resolveSantanderMovementsDir()): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((name) => /^card-movements-.*\.json$/.test(name))
    .sort()
    .map((name) => path.join(dir, name));
}

/** The close the feed's SALDO INICIAL states, as recorded for this import. */
export type SantanderFeedCloseImport = {
  close_iso: string;
  billing_month: string;
  /** `new` the first time this close is seen, `seen` on the daily repeats. */
  status: "new" | "seen";
  saldo_inicial_clp: number | null;
  saldo_inicial_usd: number | null;
  /** The facturación every row of this feed was filed under (the month after the close). */
  rows_billing_month: string;
  /** Lines already on file under an earlier month that this post-close feed still lists. */
  lines_moved_forward: number;
  /**
   * For a provisionally closed month: the bank's total in CLP (USD at the pay-by) next to the
   * app's own estimate for it (únicos + cuotas) — a gap is purchases the fetches missed, a
   * mis-scheduled cuota, or pre-authorizations the statement will settle differently.
   */
  provisional_check: { bank_total_clp: number; app_estimate_clp: number } | null;
};

export type SantanderAccountImportResult = {
  account: string;
  account_id: number;
  lines_parsed: number;
  inserted: number;
  skipped_duplicate: number;
  /** Cuota-billing reference rows (`CUOT: N OPER: M`) the feed lists at a facturación close. */
  skipped_cuota_billing: number;
  batch_id: number | null;
  feed_close: SantanderFeedCloseImport | null;
  /** Feed cuota purchases with a known count, turned into plans (`ccFeedCuotaPurchases.ts`). */
  plans_created: CcFeedPlanCreated[];
  /** Hand-entered plans whose first cuota the feed's type moved. */
  first_due_nudges: CcInstallmentFirstDueNudge[];
  /** Bucket lines tagged as cuota purchases whose count is not known yet. */
  cuota_lines_tagged: number;
  /** Lines the bank no longer lists, removed (`ccFeedMirror.ts`); null when the feed had no close. */
  mirror: CcFeedMirrorResult | null;
};

export type SantanderMovementsImportResult = {
  file: string;
  accounts: SantanderAccountImportResult[];
  /** The bank's own cupo per card and currency the same session read (`cc_bank_cupo_*`). */
  bank_cupo: BankCupoCaptureResult;
};

/**
 * Record the feed's close and move what it still lists past it. One transaction: a cross-check
 * failure (the SALDO INICIAL disagrees with an imported statement of the same close) leaves no
 * observation and moves nothing.
 */
function applyFeedClose(
  accountId: number,
  close: ReturnType<typeof santanderFeedClosesByAccount>[number],
  lines: Parameters<typeof webPasteLineDedupeKey>[1][],
  sourceFile: string
): Omit<SantanderFeedCloseImport, "provisional_check"> {
  return db.transaction(() => {
    const recorded = recordFeedBillingClose(accountId, {
      close_iso: close.close_iso,
      saldo_inicial_clp: close.saldo_inicial_clp,
      saldo_inicial_usd: close.saldo_inicial_usd,
      source_file: sourceFile,
    });
    assertFeedClosesMatchStatements(accountId);
    const rowsBillingMonth = addCalendarMonths(recorded.close.billing_month, 1);
    const meta = creditCardMasterMetaForAccount(accountId);
    const keys = new Set(lines.map((line) => webPasteLineDedupeKey(meta.cardGroup, line)));
    const moved = moveOpenBucketLinesByDedupeKey(accountId, keys, rowsBillingMonth);
    return {
      close_iso: recorded.close.close_date,
      billing_month: recorded.close.billing_month,
      status: recorded.status,
      saldo_inicial_clp: recorded.close.saldo_inicial_clp,
      saldo_inicial_usd: recorded.close.saldo_inicial_usd,
      rows_billing_month: rowsBillingMonth,
      lines_moved_forward: moved.moved,
    };
  })();
}

function provisionalCheck(
  accountId: number,
  billingMonth: string
): SantanderFeedCloseImport["provisional_check"] {
  const row = billingDetailCacheForAccount(accountId).facturaciones.find(
    (f) => f.billing_month === billingMonth
  );
  if (!row?.is_provisional_close || row.provisional_estimate_total_clp == null) return null;
  return {
    bank_total_clp: row.facturado_total_clp ?? 0,
    app_estimate_clp: row.provisional_estimate_total_clp,
  };
}

/**
 * Import one fetched movements file.
 *
 * Re-importing the same file is harmless: the lines carry the same `ccOneShotDedupeKey` a manual
 * paste would produce, so repeats are skipped as duplicates. That is what makes a daily fetch of an
 * overlapping window (the feed returns the whole unbilled period every time) safe to run.
 *
 * Every file fetched since 2026-09-26 also carries each card's SALDO INICIAL — its latest close.
 * That close is recorded (`cc_feed_billing_closes`), and since everything a post-close feed lists
 * is unbilled by definition, every row is filed under the facturación AFTER it, and any line
 * already filed under an earlier month that the feed still lists follows it forward.
 */
export function importSantanderMovementsFile(file: string): SantanderMovementsImportResult {
  const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as SantanderMovementsFile;
  const grouped = santanderMovementsByAccount(parsed);
  const closes = new Map(santanderFeedClosesByAccount(parsed).map((c) => [c.account, c]));
  // Validated before any write, recorded after the lines: the check compares it with the ledger
  // this file leaves behind.
  const bankCupo = parseBankCupoCapture(parsed);
  // A card whose feed carries only its SALDO INICIAL (no movements yet) still reports its close.
  for (const account of closes.keys()) {
    if (!grouped.some((g) => g.account === account)) grouped.push({ account, lines: [] });
  }

  const accounts: SantanderAccountImportResult[] = [];
  for (const group of grouped) {
    const accountId = masterAccountIdForSantanderAccount(group.account);
    const close = closes.get(group.account);
    const feedClose = close
      ? applyFeedClose(accountId, close, group.lines, path.basename(file))
      : null;
    // Before the lines: a plan makes its purchase row import as an installment overlap.
    const plansCreated = createPlansForFeedCuotaPurchases(accountId, group.lines, path.basename(file));
    const result = importCcWebPasteLines(
      accountId,
      { lines: group.lines, errors: [] },
      "cc_santander_fetch",
      feedClose ? { targetBillingMonth: feedClose.rows_billing_month } : undefined
    );
    const tagged = tagFeedCuotaPurchaseLines(accountId, group.lines);
    // The merge re-syncs balances and valuation points after any write; a close with nothing to
    // write (no movements, or only repeats) changed the facturación state all the same.
    if (feedClose && result.batch_id == null && (feedClose.status === "new" || feedClose.lines_moved_forward > 0)) {
      recomputeCcBillingMonthBalances(accountId);
      upsertCreditCardValuationsFromLedger(accountId);
    }
    // Last: everything this feed lists is now on file, so what the buckets hold beyond it is
    // what the bank dropped. Only with a close (the window start) and per complete currency.
    const mirrorCurrencies = new Set<"clp" | "usd">();
    if (close?.saldo_inicial_clp != null) mirrorCurrencies.add("clp");
    if (close?.saldo_inicial_usd != null) mirrorCurrencies.add("usd");
    const mirror =
      feedClose && mirrorCurrencies.size > 0
        ? mirrorOpenBucketsToFeed(accountId, {
            windowStartIso: feedClose.close_iso,
            currencies: mirrorCurrencies,
            feedLines: group.lines,
          })
        : null;
    accounts.push({
      account: group.account,
      account_id: accountId,
      lines_parsed: result.lines_parsed,
      inserted: result.inserted,
      skipped_duplicate: result.skipped_duplicate,
      skipped_cuota_billing: result.skipped_cuota_billing,
      batch_id: result.batch_id,
      feed_close: feedClose
        ? { ...feedClose, provisional_check: provisionalCheck(accountId, feedClose.billing_month) }
        : null,
      plans_created: plansCreated,
      first_due_nudges: result.installment_first_due_nudges ?? [],
      cuota_lines_tagged: tagged.length,
      mirror,
    });
  }
  return {
    file: path.basename(file),
    accounts,
    bank_cupo: recordBankCupoCapture(path.basename(file), bankCupo, closes),
  };
}

/**
 * Import every staged file, then move each into `imported/`.
 *
 * Archiving rather than deleting keeps the raw feed around: it is the only copy of what the bank
 * actually returned on a given day, and re-importing it is idempotent if it is ever needed.
 */
export function importStagedSantanderMovements(dir = resolveSantanderMovementsDir()): SantanderMovementsImportResult[] {
  const files = listSantanderMovementFiles(dir);
  const results: SantanderMovementsImportResult[] = [];
  for (const file of files) {
    results.push(importSantanderMovementsFile(file));
    const archive = path.join(dir, "imported");
    fs.mkdirSync(archive, { recursive: true });
    fs.renameSync(file, path.join(archive, path.basename(file)));
  }
  return results;
}
