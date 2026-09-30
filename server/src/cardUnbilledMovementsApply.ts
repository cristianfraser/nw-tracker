import type { CardUnbilledMovementsPayload } from "nw-tracker-contracts";
import { importCcWebPasteLines } from "./accountImports.js";
import { masterAccountIdForIssuerCardAccount } from "./santanderAccountMap.js";
import { webPasteLineFromCardListingLine } from "./cardListingLines.js";
import type { CcWebPasteLine } from "./ccWebPasteParse.js";
import {
  assertFeedClosesMatchStatements,
  recordFeedBillingClose,
} from "./ccBillingCloses.js";
import { moveOpenBucketLinesByDedupeKey } from "./ccOpenWebPasteRepair.js";
import { creditCardMasterMetaForAccount, webPasteLineDedupeKey } from "./ccWebPasteParse.js";
import { invalidateCcBillingDetail } from "./aggregationCache.js";
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
  bankCupoCaptureFromListing,
  recordBankCupoCapture,
  type BankCupoCaptureResult,
} from "./santanderBankCupo.js";

/** A card's latest close as a listing states it: date + billed total per currency (debt-positive). */
export type CardListingClose = {
  /** The issuer's account number. */
  account: string;
  close_iso: string;
  /** Null when the listing did not state that currency. */
  saldo_inicial_clp: number | null;
  saldo_inicial_usd: number | null;
};

/** The close the listing states (the feed's SALDO INICIAL), as recorded for this import. */
export type CardListingCloseImport = {
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

export type CardListingAccountImportResult = {
  account: string;
  account_id: number;
  lines_parsed: number;
  inserted: number;
  skipped_duplicate: number;
  /** Cuota-billing reference rows (`CUOT: N OPER: M`) the feed lists at a facturación close. */
  skipped_cuota_billing: number;
  batch_id: number | null;
  feed_close: CardListingCloseImport | null;
  /** Feed cuota purchases with a known count, turned into plans (`ccFeedCuotaPurchases.ts`). */
  plans_created: CcFeedPlanCreated[];
  /** Hand-entered plans whose first cuota the feed's type moved. */
  first_due_nudges: CcInstallmentFirstDueNudge[];
  /** Bucket lines tagged as cuota purchases whose count is not known yet. */
  cuota_lines_tagged: number;
  /** Lines the bank no longer lists, removed (`ccFeedMirror.ts`); null when the feed had no close. */
  mirror: CcFeedMirrorResult | null;
};

export type CardUnbilledMovementsImportResult = {
  /** The document the listing came from (the feeder's source ref, e.g. the fetched file's name). */
  source: string;
  accounts: CardListingAccountImportResult[];
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
  close: CardListingClose,
  lines: CcWebPasteLine[],
  sourceFile: string
): Omit<CardListingCloseImport, "provisional_check"> {
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
): CardListingCloseImport["provisional_check"] {
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
 * Apply one `card.unbilled_movements` listing (`sourceRef` = the feeder's document identity; it
 * keys the feed close and the cupo capture, so a resend of the same document is a repeat).
 *
 * Re-applying the same listing is harmless: the lines carry the same `ccOneShotDedupeKey` a manual
 * paste would produce, so repeats are skipped as duplicates. That is what makes a daily fetch of an
 * overlapping window (the feed returns the whole unbilled period every time) safe to run.
 *
 * A listing that states a card's latest close (the feed's SALDO INICIAL) records it
 * (`cc_feed_billing_closes`), and since everything a post-close listing shows is unbilled by
 * definition, every row is filed under the facturación AFTER it, and any line already filed
 * under an earlier month that the listing still shows follows it forward.
 */
export function applyCardUnbilledMovements(
  payload: CardUnbilledMovementsPayload,
  sourceRef: string
): CardUnbilledMovementsImportResult {
  const closes = new Map<string, CardListingClose>();
  for (const card of payload.cards) {
    if (!card.close) continue;
    closes.set(card.account.number, {
      account: card.account.number,
      close_iso: card.close.date,
      saldo_inicial_clp: card.close.billed.clp,
      saldo_inicial_usd: card.close.billed.usd,
    });
  }
  // Validated before any write, recorded after the lines: the check compares it with the ledger
  // this listing leaves behind.
  const bankCupo = bankCupoCaptureFromListing(payload.issuer_balances);

  const accounts: CardListingAccountImportResult[] = [];
  for (const card of payload.cards) {
    const accountId = masterAccountIdForIssuerCardAccount(card.account);
    const { cardGroup } = creditCardMasterMetaForAccount(accountId);
    const lines = card.lines.map((line) => webPasteLineFromCardListingLine(cardGroup, line));
    const close = closes.get(card.account.number);
    const feedClose = close ? applyFeedClose(accountId, close, lines, sourceRef) : null;
    // Before the lines: a plan makes its purchase row import as an installment overlap.
    const plansCreated = createPlansForFeedCuotaPurchases(accountId, lines, sourceRef);
    const result = importCcWebPasteLines(
      accountId,
      { lines, errors: [] },
      "cc_santander_fetch",
      feedClose ? { targetBillingMonth: feedClose.rows_billing_month } : undefined
    );
    const tagged = tagFeedCuotaPurchaseLines(accountId, lines);
    // The merge re-syncs balances and valuation points after any write; a close with nothing to
    // write (no movements, or only repeats) changed the facturación state all the same.
    if (feedClose && result.batch_id == null && (feedClose.status === "new" || feedClose.lines_moved_forward > 0)) {
      recomputeCcBillingMonthBalances(accountId);
      upsertCreditCardValuationsFromLedger(accountId);
    }
    // Last: everything this listing shows is now on file, so what the buckets hold beyond it is
    // what the bank dropped. Only with a close (the window start) and per complete currency.
    const mirrorCurrencies = new Set<"clp" | "usd">();
    if (close?.saldo_inicial_clp != null) mirrorCurrencies.add("clp");
    if (close?.saldo_inicial_usd != null) mirrorCurrencies.add("usd");
    const mirror =
      feedClose && mirrorCurrencies.size > 0
        ? mirrorOpenBucketsToFeed(accountId, {
            windowStartIso: feedClose.close_iso,
            currencies: mirrorCurrencies,
            feedLines: lines,
          })
        : null;
    // In-process writes do not bump data_version: drop this card's derived caches explicitly.
    invalidateCcBillingDetail(accountId);
    accounts.push({
      account: card.account.number,
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
    source: sourceRef,
    accounts,
    bank_cupo: recordBankCupoCapture(sourceRef, bankCupo, closes),
  };
}
