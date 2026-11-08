import type { CardUnbilledMovementsPayload } from "nw-tracker-contracts";
import { applyLinePlan, cardLineWrite, insertLines, runFinancingLinks } from "./cards/lineWrites.js";
import { noteCardLineWritten } from "./cards/lineWriteSession.js";
import { withExpenseLinkSyncDeferred } from "./expenseLinkSync.js";
import { cardAccountForIssuerNumber } from "./cards/documentAccount.js";
import { listingLineFromCardListingLine } from "./cardListingLines.js";
import type { CcListingLine } from "./ccWebPasteParse.js";
import { assertFeedClosesMatchStatements, recordFeedBillingClose } from "./ccBillingCloses.js";
import { latestFeedBillingClose } from "./cards/facturacion.js";
import { moveOpenBucketLinesByDedupeKey } from "./ccOpenWebPasteRepair.js";
import { creditCardMasterMetaForAccount, webPasteListingDedupeKeys } from "./ccWebPasteParse.js";

import { ymCompare } from "./calendarMonth.js";
import { billingMonthContainingPurchase } from "./cards/facturacion.js";
import { listCcStatementsForAccount } from "./ccStatementsDb.js";
import { db } from "./db.js";
import { billingDetailCacheForAccount } from "./ccBillingDetailCache.js";
import {
  createPlansForFeedCuotaPurchases,
  tagFeedCuotaPurchaseLines,
  type CcFeedPlanCreated,
} from "./ccFeedCuotaPurchases.js";
import { feedMirrorCurrencies, planOpenBucketMirror, type CcFeedMirrorResult } from "./ccFeedMirror.js";
import type { PlantedPaymentMatchResult } from "./ccPlantedPayments.js";
import type { CcInstallmentFirstDueNudge } from "./ccWebPasteInstallmentNudge.js";
import {
  bankCupoCaptureFromListing,
  recordBankCupoCapture,
  type BankCupoCaptureResult,
} from "./santanderBankCupo.js";
import { addCalendarMonths } from "nw-tracker-contracts";

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
  /**
   * The facturación this feed's rows are filed under by default: the month after the close. A
   * row dated in a later cycle than that month's (a close-day purchase on the close day itself,
   * before the listing rolls) is filed under its own cycle's month instead (`feedLineBillingMonths`).
   */
  rows_billing_month: string;
  /** Rows of this feed filed under a later facturación than `rows_billing_month`. */
  lines_in_later_cycle: number;
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
  /** Planted payment lines the listing replaced or confirmed (`ccPlantedPayments.ts`). */
  planted_payments: PlantedPaymentMatchResult;
};

export type CardUnbilledMovementsImportResult = {
  /** The document the listing came from (the feeder's source ref, e.g. the fetched file's name). */
  source: string;
  accounts: CardListingAccountImportResult[];
  /** The bank's own cupo per card and currency the same session read (`cc_bank_cupo_*`). */
  bank_cupo: BankCupoCaptureResult;
};

/**
 * The facturación each feed row is filed under: the LATER of the feed's own month (the one after
 * its SALDO INICIAL close — everything a post-close listing shows is unbilled, so never earlier)
 * and the cycle containing the row's date (`billingMonthContainingPurchase`: statement, feed and
 * announced closes plus the issuer's close-day rule). The bank rolls the unbilled list the night
 * AFTER a close day: on the close day itself the evening listing still opens with the previous
 * SALDO INICIAL, so a purchase dated that day — which Santander bills in the NEXT cycle, its
 * next period starting ON the close day — would otherwise sit a day in the closing month's bucket
 * and inflate its provisional estimate until the next listing moved it forward. A pending
 * authorization carries a date too; a row with no ISO date throws, never a guess.
 */
export function feedLineBillingMonths(
  accountId: number,
  lines: readonly CcListingLine[],
  feedBillingMonth: string
): string[] {
  if (lines.length === 0) return [];
  const statements = listCcStatementsForAccount(accountId);
  return lines.map((line) => {
    const own = billingMonthContainingPurchase(accountId, line.transaction_date, statements);
    return ymCompare(own, feedBillingMonth) > 0 ? own : feedBillingMonth;
  });
}

/**
 * Record the feed's close and move what it still lists past it — each line to its own month
 * (`feedLineBillingMonths`). One transaction: a cross-check failure (the SALDO INICIAL disagrees
 * with an imported statement of the same close) leaves no observation and moves nothing.
 */
function applyFeedClose(
  accountId: number,
  close: CardListingClose,
  lines: CcListingLine[],
  sourceFile: string
): { close: Omit<CardListingCloseImport, "provisional_check">; lineBillingMonths: string[] } {
  return db.transaction(() => {
    const recorded = recordFeedBillingClose(accountId, {
      close_iso: close.close_iso,
      saldo_inicial_clp: close.saldo_inicial_clp,
      saldo_inicial_usd: close.saldo_inicial_usd,
      source_file: sourceFile,
    });
    assertFeedClosesMatchStatements(accountId);
    const rowsBillingMonth = addCalendarMonths(recorded.close.billing_month, 1);
    // After the close is on record: it is evidence for the cycles the lines fall in.
    const lineBillingMonths = feedLineBillingMonths(accountId, lines, rowsBillingMonth);
    const meta = creditCardMasterMetaForAccount(accountId);
    const keys = webPasteListingDedupeKeys(meta.cardGroup, lines);
    const keysByMonth = new Map<string, Set<string>>();
    keys.forEach((key, i) => {
      const month = lineBillingMonths[i]!;
      let set = keysByMonth.get(month);
      if (!set) keysByMonth.set(month, (set = new Set()));
      set.add(key);
    });
    let moved = 0;
    for (const [month, monthKeys] of keysByMonth) {
      moved += moveOpenBucketLinesByDedupeKey(accountId, monthKeys, month).moved;
    }
    return {
      close: {
        close_iso: recorded.close.close_date,
        billing_month: recorded.close.billing_month,
        status: recorded.status,
        saldo_inicial_clp: recorded.close.saldo_inicial_clp,
        saldo_inicial_usd: recorded.close.saldo_inicial_usd,
        rows_billing_month: rowsBillingMonth,
        lines_in_later_cycle: lineBillingMonths.filter((m) => m !== rowsBillingMonth).length,
        lines_moved_forward: moved,
      },
      lineBillingMonths,
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
 * definition, every row is filed under the facturación AFTER it — or under its own date's cycle
 * when that is later (`feedLineBillingMonths`) — and any line already filed under an earlier
 * month that the listing still shows follows it forward.
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
  withExpenseLinkSyncDeferred(() => {
    for (const card of payload.cards) {
      const accountId = cardAccountForIssuerNumber(card.account);
      // One card-line write per card: the close, the plans, the lines, the tags and the mirror
      // land together and the card re-syncs once.
      const listed = cardLineWrite(accountId, "card feed", () => applyCardListing(accountId, card, closes, bankCupo, sourceRef));
      // After the write's re-sync: the check reads the facturación the write left.
      accounts.push({
        ...listed,
        feed_close: listed.feed_close
          ? { ...listed.feed_close, provisional_check: provisionalCheck(accountId, listed.feed_close.billing_month) }
          : null,
      });
    }
    // Tagged cuota purchases (count unknown) are marked after their card's write: one more pass,
    // so a facturado one of them paid gets its PAGO tonight rather than at the next card write.
    runFinancingLinks();
  });
  return {
    source: sourceRef,
    accounts,
    bank_cupo: recordBankCupoCapture(sourceRef, bankCupo, closes),
  };
}

/** One card of a listing, inside its card-line write. */
function applyCardListing(
  accountId: number,
  card: CardUnbilledMovementsPayload["cards"][number],
  closes: Map<string, CardListingClose>,
  bankCupo: ReturnType<typeof bankCupoCaptureFromListing>,
  sourceRef: string
): Omit<CardListingAccountImportResult, "feed_close"> & { feed_close: Omit<CardListingCloseImport, "provisional_check"> | null } {
  const lines = card.lines.map((line) => listingLineFromCardListingLine(line));
  const close = closes.get(card.account.number);
  const applied = close ? applyFeedClose(accountId, close, lines, sourceRef) : null;
  const feedClose = applied?.close ?? null;
  // Before the lines: a plan makes its purchase row import as an installment overlap.
  const plansCreated = createPlansForFeedCuotaPurchases(accountId, lines, sourceRef);
  const result = insertLines(
    accountId,
    { lines, errors: [] },
    "cc_santander_fetch",
    applied
      ? { targetBillingMonth: applied.close.rows_billing_month, lineBillingMonths: applied.lineBillingMonths }
      : undefined
  );
  const tagged = tagFeedCuotaPurchaseLines(accountId, lines);
  // A close with nothing to write (no movements, or only repeats) changed the facturación state
  // all the same: the card re-syncs.
  if (feedClose && (feedClose.status === "new" || feedClose.lines_moved_forward > 0)) noteCardLineWritten(accountId);
  // Last: everything this listing shows is now on file, so what the buckets hold beyond it is
  // what the bank dropped. Only from a close on record (the window start) and per currency the
  // listing proves complete: its SALDO INICIAL row, or the bank's cupo identity.
  const stated = new Set<"clp" | "usd">();
  if (close?.saldo_inicial_clp != null) stated.add("clp");
  if (close?.saldo_inicial_usd != null) stated.add("usd");
  const recordedClose = feedClose ? null : latestFeedBillingClose(accountId);
  const windowStartIso = feedClose?.close_iso ?? recordedClose?.close_date ?? null;
  const closeOnRecord = feedClose ?? recordedClose;
  const bankUsed: Partial<Record<"clp" | "usd", number>> = {};
  if (bankCupo.status === "present") {
    for (const row of bankCupo.rows) if (row.account_id === accountId) bankUsed[row.currency] = row.cupo_utilizado;
  }
  const proof =
    windowStartIso && closeOnRecord
      ? feedMirrorCurrencies({ stated, closeOnRecord, lines: card.lines, bankUsed })
      : {};
  let mirror: CcFeedMirrorResult | null = null;
  if (windowStartIso && Object.keys(proof).length > 0) {
    const planned = planOpenBucketMirror(accountId, { windowStartIso, proof, feedLines: lines });
    applyLinePlan(accountId, "card feed mirror", planned.plan);
    mirror = planned.result;
  }
  return {
    account: card.account.number,
    account_id: accountId,
    lines_parsed: result.lines_parsed,
    inserted: result.inserted,
    skipped_duplicate: result.skipped_duplicate,
    skipped_cuota_billing: result.skipped_cuota_billing,
    batch_id: result.batch_id,
    feed_close: feedClose,
    plans_created: plansCreated,
    first_due_nudges: result.installment_first_due_nudges ?? [],
    cuota_lines_tagged: tagged.length,
    mirror,
    planted_payments: result.planted_payments,
  };
}
