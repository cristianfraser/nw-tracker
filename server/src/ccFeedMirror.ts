/**
 * Mirror the Santander card feed onto the open buckets (2026-09-26).
 *
 * The feed returns the card's whole unbilled list on every fetch, so a bucket line of the current
 * cycle that the feed no longer lists is something the bank dropped: a pending authorization it
 * voided, or restated under another name and date. Such lines stayed until the statement's
 * reconcile deleted them — «CONVENIO P.A.T.» 2x.xxx on 03/09/2026, the bank's pending listing of
 * the car insurance it then posted as «SEG AUTO SANTANDER» on 07/09, counted twice in the owed
 * walk for three weeks.
 *
 * Guards, because deleting is the one thing an import must never do by accident:
 *  - only a currency the listing proves complete ({@link feedMirrorCurrencies}): its slide carried
 *    the SALDO INICIAL row, or the bank's own cupo utilizado for it equals the close on record plus
 *    the listed rows to the cent — the bank's identity the cupo check judges by (a failed Dólares
 *    tab must not read as «every USD purchase vanished»; 2026-10-19 the dollar slide listed all 20
 *    rows but no SALDO INICIAL, and the row-only rule left a restated pending authorization
 *    counted twice, which the cupo check then flagged),
 *  - only lines dated on/after the latest close (the current cycle; the closed cycle's lines are
 *    its evidence until the statement arrives),
 *  - never payments / divisas abonos (a payment planted from a bank receipt precedes the feed),
 *  - «listed» uses the importer's own notion of the same purchase (`bucketLineMatchesFeedLine`:
 *    same amount, matching merchant incl. the paste's 15-character cut, dates ≤ 4 days apart),
 *  - more than {@link MIRROR_MAX_DELETIONS} lines on one card throws with the list instead of
 *    deleting — a feed that lost half its rows is a scraper failure, not a day of voids.
 */
import {
  deleteStatementLinesByIds,
  earliestTransactionDateForLineIds,
} from "./ccCrossImportDedupe.js";
import {
  bucketLineMatchesFeedLine,
  bucketLinePurchaseIso,
  listOpenBucketLines,
  type CcOpenBucketLine,
} from "./ccFeedCuotaPurchases.js";
import { isCcPaymentOrUsdDebtAbonoMerchant } from "./ccPaymentLines.js";
import { recomputeCcBillingMonthBalances } from "./ccBillingBalances.js";
import { upsertCreditCardValuationsFromLedger } from "./ccCreditCardValuations.js";
import type { CcWebPasteLine } from "./ccWebPasteParse.js";

export const MIRROR_MAX_DELETIONS = 12;
/** A pending authorization is restated at most a few days later. */
const MIRROR_MAX_DAY_GAP = 4;

export type CcFeedMirrorRemoved = {
  id: number;
  date: string;
  merchant: string | null;
  amount_clp: number | null;
  amount_usd: number | null;
};

/** How a currency's listing was proved complete, so its missing lines may be removed. */
export type FeedMirrorCurrencyProof = "saldo_inicial" | "cupo_identity";

export type CcFeedMirrorResult = {
  window_start: string;
  currencies: ("clp" | "usd")[];
  /** Per mirrored currency, what proved its listing complete. */
  proof: Partial<Record<"clp" | "usd", FeedMirrorCurrencyProof>>;
  removed: CcFeedMirrorRemoved[];
};

function lineCurrency(line: CcOpenBucketLine): "clp" | "usd" {
  return line.amount_usd != null && line.amount_usd !== 0 ? "usd" : "clp";
}

function roundedUnits(amount: number, currency: "clp" | "usd"): number {
  return currency === "usd" ? Math.round(amount * 100) : Math.round(amount);
}

/**
 * The currencies whose listing is complete, and why (pure). A currency is complete when its slide
 * stated the close's SALDO INICIAL, or when the bank's own cupo utilizado for it, read in the same
 * session, equals the close on record plus every listed row (debt-positive) to the cent: that is
 * the bank's identity for a card's utilizado, so a listing that reproduces it lists everything the
 * bank counts. Neither holds for a tab that failed to render, and the CLP identity rarely holds
 * while cuota plans are outstanding (utilizado carries their remainder), so pesos usually keep the
 * SALDO INICIAL rule.
 */
export function feedMirrorCurrencies(opts: {
  /** Currencies whose slide carried the SALDO INICIAL row. */
  stated: ReadonlySet<"clp" | "usd">;
  /** The close on record for the card (the listing's, or the latest recorded), with its billed totals. */
  closeOnRecord: { saldo_inicial_clp: number | null; saldo_inicial_usd: number | null } | null;
  /** Every listed row, debt-positive, as the feeder sent it. */
  lines: readonly { currency: "clp" | "usd"; amount: number }[];
  /** The bank's cupo utilizado per currency, from the same session's product summary. */
  bankUsed: Partial<Record<"clp" | "usd", number>>;
}): Partial<Record<"clp" | "usd", FeedMirrorCurrencyProof>> {
  const proof: Partial<Record<"clp" | "usd", FeedMirrorCurrencyProof>> = {};
  for (const currency of ["clp", "usd"] as const) {
    if (opts.stated.has(currency)) {
      proof[currency] = "saldo_inicial";
      continue;
    }
    const saldoInicial = currency === "clp" ? opts.closeOnRecord?.saldo_inicial_clp : opts.closeOnRecord?.saldo_inicial_usd;
    const used = opts.bankUsed[currency];
    if (saldoInicial == null || used == null) continue;
    const listed = opts.lines
      .filter((l) => l.currency === currency)
      .reduce((sum, l) => sum + roundedUnits(l.amount, currency), 0);
    if (roundedUnits(saldoInicial, currency) + listed === roundedUnits(used, currency)) {
      proof[currency] = "cupo_identity";
    }
  }
  return proof;
}

/** Bucket lines of the mirrored window that no feed row accounts for (read-only planner). */
export function planFeedMirror(
  accountId: number,
  opts: { windowStartIso: string; currencies: ReadonlySet<"clp" | "usd">; feedLines: readonly CcWebPasteLine[] }
): CcOpenBucketLine[] {
  const candidates = listOpenBucketLines(accountId).filter((line) => {
    if (line.installment_flag) return false;
    if (!opts.currencies.has(lineCurrency(line))) return false;
    if (isCcPaymentOrUsdDebtAbonoMerchant(line.merchant)) return false;
    const iso = bucketLinePurchaseIso(line);
    return iso != null && iso >= opts.windowStartIso;
  });
  const feed = opts.feedLines.filter((f) => opts.currencies.has(f.currency));
  const usedFeedRows = new Set<number>();
  const listed = new Set<number>();
  // Exact-date matches first, so a same-amount purchase a few days later can't steal the row.
  for (const maxDayGap of [0, MIRROR_MAX_DAY_GAP]) {
    for (const line of candidates) {
      if (listed.has(line.id)) continue;
      const idx = feed.findIndex(
        (f, i) => !usedFeedRows.has(i) && bucketLineMatchesFeedLine(line, f, maxDayGap)
      );
      if (idx < 0) continue;
      usedFeedRows.add(idx);
      listed.add(line.id);
    }
  }
  return candidates.filter((line) => !listed.has(line.id));
}

export function mirrorOpenBucketsToFeed(
  accountId: number,
  opts: {
    windowStartIso: string;
    proof: Partial<Record<"clp" | "usd", FeedMirrorCurrencyProof>>;
    feedLines: readonly CcWebPasteLine[];
  }
): CcFeedMirrorResult {
  const currencies = new Set((Object.keys(opts.proof) as ("clp" | "usd")[]).filter((c) => opts.proof[c] != null));
  const unlisted = planFeedMirror(accountId, { windowStartIso: opts.windowStartIso, currencies, feedLines: opts.feedLines });
  const removed = unlisted.map((l) => ({
    id: l.id,
    date: bucketLinePurchaseIso(l) ?? String(l.transaction_date ?? ""),
    merchant: l.merchant,
    amount_clp: l.amount_clp,
    amount_usd: l.amount_usd,
  }));
  const result: CcFeedMirrorResult = {
    window_start: opts.windowStartIso,
    currencies: [...currencies].sort(),
    proof: opts.proof,
    removed,
  };
  if (removed.length === 0) return result;
  if (removed.length > MIRROR_MAX_DELETIONS) {
    throw new Error(
      `Account ${accountId}: the card feed no longer lists ${removed.length} open-bucket lines dated from ` +
        `${opts.windowStartIso} — more than ${MIRROR_MAX_DELETIONS}, so nothing was removed. A feed that ` +
        `lost this many rows is more likely a fetch failure than voided authorizations: ` +
        removed
          .map((r) => `${r.date} ${r.merchant} ${r.amount_usd ? `US$${r.amount_usd}` : r.amount_clp}`)
          .join("; ")
    );
  }
  const ids = removed.map((r) => r.id);
  const affectedFrom = earliestTransactionDateForLineIds(ids);
  deleteStatementLinesByIds(ids);
  upsertCreditCardValuationsFromLedger(accountId, { affectedEvidenceFromYmd: affectedFrom });
  recomputeCcBillingMonthBalances(accountId);
  return result;
}
