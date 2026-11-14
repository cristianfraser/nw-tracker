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
import type { CardLinePlan } from "./cards/lineWriteSession.js";
import {
  bucketLineMatchesFeedLine,
  bucketLinePurchaseIso,
  listOpenBucketLines,
  merchantsSame,
  type CcOpenBucketLine,
} from "./ccFeedCuotaPurchases.js";
import { daysBetweenIso } from "nw-tracker-contracts";
import { isCcPaymentOrUsdDebtAbonoMerchant } from "./ccPaymentLines.js";
import type { CcListingLine } from "./ccWebPasteParse.js";
import { pairOneToOne } from "./matching/pairing.js";
import { MATCH_WINDOWS } from "./matching/windows.js";

export const MIRROR_MAX_DELETIONS = 12;

export type CcFeedMirrorRemoved = {
  id: number;
  date: string;
  merchant: string | null;
  amount_clp: number | null;
  amount_usd: number | null;
};

/** How a currency's listing was proved complete, so its missing lines may be removed. */
export type FeedMirrorCurrencyProof = "saldo_inicial" | "cupo_identity";

/** An unlisted line kept as an annulled purchase (`ccAnnulledPurchases.ts`) instead of deleted. */
export type CcFeedMirrorAnnulled = CcFeedMirrorRemoved & {
  /** The `cc_annulled_purchases` row written for it. */
  annulled_purchase_id: number;
  basis: "feed_drop" | "cupo_gap";
};

export type CcFeedMirrorResult = {
  window_start: string;
  currencies: ("clp" | "usd")[]; // convention-ok: Santander's card feed has a peso and a dollar slide only
  /** Per mirrored currency, what proved its listing complete. */
  proof: Partial<Record<"clp" | "usd", FeedMirrorCurrencyProof>>; // convention-ok: Santander's card feed has a peso and a dollar slide only
  /** Restatements deleted: the bank re-listed the purchase under another amount, name or date. */
  removed: CcFeedMirrorRemoved[];
  /** Lines the bank dropped without restating them: kept as purchase + annulment. */
  annulled: CcFeedMirrorAnnulled[];
};

function lineCurrency(line: CcOpenBucketLine): "clp" | "usd" { // convention-ok: Santander's card feed has a peso and a dollar slide only
  return line.amount_usd != null && line.amount_usd !== 0 ? "usd" : "clp";
}

function roundedUnits(amount: number, currency: "clp" | "usd"): number { // convention-ok: Santander's card feed has a peso and a dollar slide only
  return currency === "usd" ? Math.round(amount * 100) : Math.round(amount); // convention-ok: pesos have no minor unit; dollars round to the cent
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
  stated: ReadonlySet<"clp" | "usd">; // convention-ok: Santander's card feed has a peso and a dollar slide only
  /** The close on record for the card (the listing's, or the latest recorded), with its billed totals. */
  closeOnRecord: { saldo_inicial_clp: number | null; saldo_inicial_usd: number | null } | null;
  /** Every listed row, debt-positive, as the feeder sent it. */
  lines: readonly { currency: "clp" | "usd"; amount: number }[]; // convention-ok: Santander's card feed has a peso and a dollar slide only
  /** The bank's cupo utilizado per currency, from the same session's product summary. */
  bankUsed: Partial<Record<"clp" | "usd", number>>; // convention-ok: Santander's card feed has a peso and a dollar slide only
}): Partial<Record<"clp" | "usd", FeedMirrorCurrencyProof>> { // convention-ok: Santander's card feed has a peso and a dollar slide only
  const proof: Partial<Record<"clp" | "usd", FeedMirrorCurrencyProof>> = {}; // convention-ok: Santander's card feed has a peso and a dollar slide only
  for (const currency of ["clp", "usd"] as const) { // convention-ok: Santander's card feed has a peso and a dollar slide only
    if (opts.stated.has(currency)) {
      proof[currency] = "saldo_inicial";
      continue;
    }
    const saldoInicial = currency === "clp" ? opts.closeOnRecord?.saldo_inicial_clp : opts.closeOnRecord?.saldo_inicial_usd; // convention-ok: Santander's card feed has a peso and a dollar slide only
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
  opts: { windowStartIso: string; currencies: ReadonlySet<"clp" | "usd">; feedLines: readonly CcListingLine[] } // convention-ok: Santander's card feed has a peso and a dollar slide only
): CcOpenBucketLine[] {
  const candidates = listOpenBucketLines(accountId).filter((line) => {
    if (line.installment_flag) return false;
    if (!opts.currencies.has(lineCurrency(line))) return false;
    if (isCcPaymentOrUsdDebtAbonoMerchant(line.merchant)) return false;
    const iso = bucketLinePurchaseIso(line);
    return iso != null && iso >= opts.windowStartIso;
  });
  const feed = opts.feedLines.filter((f) => opts.currencies.has(f.currency));
  // Exact-date matches first, so a same-amount purchase a few days later can't steal the row; each
  // pass pairs the first fitting row (the feed's own order — not the nearest, kept as it was).
  let unlisted = [...candidates];
  let freeFeed = [...feed];
  for (const maxDayGap of [0, MATCH_WINDOWS.feed_mirror.daysAfter]) {
    const pass = pairOneToOne(unlisted, freeFeed, {
      strategy: "first",
      accepts: (line, f) => bucketLineMatchesFeedLine(line, f, maxDayGap),
    });
    unlisted = pass.unpaired;
    freeFeed = pass.unclaimed;
  }
  return unlisted;
}

/**
 * What an unlisted line became (pure):
 *  - `re_settlement`: the listing has a row of the same currency with a matching merchant and
 *    ANOTHER amount within `MATCH_WINDOWS.feed_mirror` days — a pre-authorization that settled;
 *  - `restatement`: the listing has a row of the same currency and amount within the window that
 *    is not the line's own same-day, same-merchant duplicate — the bank restated the purchase under
 *    another name («CONVENIO P.A.T.» → «SEG AUTO SANTANDER») or a day later (pending → posted).
 *    Every such row is also paired to a bucket line of its own (the import inserted it), so «no
 *    other line accounts for it» cannot be asked literally; the same-day same-merchant row is the
 *    one that does NOT count, because it is a genuine twin purchase (one of two identical
 *    purchases voided). Each row restates at most one line;
 *  - `credit`: not a charge (a pasted credit or payment) — there is no purchase to keep, deleted;
 *  - `dropped`: none of those — the bank voided the purchase.
 * Restatements change no history (the line they replace is deleted); dropped lines are annulled.
 */
export type UnlistedLineKind = "re_settlement" | "restatement" | "credit" | "dropped";

export function classifyUnlistedLines(
  unlisted: readonly CcOpenBucketLine[],
  feedLines: readonly CcListingLine[]
): { line: CcOpenBucketLine; kind: UnlistedLineKind }[] {
  const window = MATCH_WINDOWS.feed_mirror.daysAfter;
  const taken = new Set<number>();
  return unlisted.map((line) => {
    const iso = bucketLinePurchaseIso(line);
    const usd = line.amount_usd != null && line.amount_usd !== 0;
    if (!((usd ? line.amount_usd : line.amount_clp) ?? 0) || ((usd ? line.amount_usd! : line.amount_clp!) < 0)) {
      return { line, kind: "credit" as const };
    }
    const currency = usd ? "usd" : "clp"; // convention-ok: Santander's card feed has a peso and a dollar slide only
    const amount = Math.abs(usd ? line.amount_usd! : (line.amount_clp ?? 0));
    const sameAmount = (f: CcListingLine): boolean =>
      usd ? Math.abs(Math.abs(f.amount) - amount) <= 0.005 : Math.round(Math.abs(f.amount)) === Math.round(amount);
    const nearIdx: number[] = [];
    feedLines.forEach((f, i) => {
      if (f.currency === currency && iso != null && Math.abs(daysBetweenIso(iso, f.transaction_date)) <= window) nearIdx.push(i);
    });
    if (nearIdx.some((i) => !sameAmount(feedLines[i]!) && merchantsSame(line.merchant, feedLines[i]!.merchant))) {
      return { line, kind: "re_settlement" as const };
    }
    const hit = nearIdx.find((i) => {
      const f = feedLines[i]!;
      return !taken.has(i) && sameAmount(f) && !(f.transaction_date === iso && merchantsSame(line.merchant, f.merchant));
    });
    if (hit != null) {
      taken.add(hit);
      return { line, kind: "restatement" as const };
    }
    return { line, kind: "dropped" as const };
  });
}

export function mirrorRemovedRow(l: CcOpenBucketLine): CcFeedMirrorRemoved {
  return {
    id: l.id,
    date: bucketLinePurchaseIso(l) ?? String(l.transaction_date ?? ""),
    merchant: l.merchant,
    amount_clp: l.amount_clp,
    amount_usd: l.amount_usd,
  };
}

/** More lines than {@link MIRROR_MAX_DELETIONS} throws with the list: a lost feed is no day of voids. */
export function assertMirrorWithinLimit(accountId: number, windowStartIso: string, lines: readonly CcOpenBucketLine[]): void {
  if (lines.length <= MIRROR_MAX_DELETIONS) return;
  throw new Error(
    `Account ${accountId}: the card feed no longer lists ${lines.length} open-bucket lines dated from ` +
      `${windowStartIso} — more than ${MIRROR_MAX_DELETIONS}, so nothing was removed. A feed that ` +
      `lost this many rows is more likely a fetch failure than voided authorizations: ` +
      lines
        .map((l) => {
          const r = mirrorRemovedRow(l);
          return `${r.date} ${r.merchant} ${r.amount_usd ? `US$${r.amount_usd}` : r.amount_clp}`;
        })
        .join("; ")
  );
}

/**
 * The lines the bank dropped from its listing (read-only planner): restatements to delete as
 * before (`plan`), the rest to annul (`toAnnul`; the caller writes the annulments and applies the
 * deletions in one card-line write). More than {@link MIRROR_MAX_DELETIONS} lines in all throws.
 */
export function planOpenBucketMirror(
  accountId: number,
  opts: {
    windowStartIso: string;
    proof: Partial<Record<"clp" | "usd", FeedMirrorCurrencyProof>>; // convention-ok: Santander's card feed has a peso and a dollar slide only
    feedLines: readonly CcListingLine[];
  }
): { result: CcFeedMirrorResult; plan: CardLinePlan; toAnnul: CcOpenBucketLine[] } {
  const currencies = new Set((Object.keys(opts.proof) as ("clp" | "usd")[]).filter((c) => opts.proof[c] != null)); // convention-ok: Santander's card feed has a peso and a dollar slide only
  const unlisted = planFeedMirror(accountId, { windowStartIso: opts.windowStartIso, currencies, feedLines: opts.feedLines });
  assertMirrorWithinLimit(accountId, opts.windowStartIso, unlisted);
  const classified = classifyUnlistedLines(unlisted, opts.feedLines);
  const restated = classified.filter((c) => c.kind !== "dropped").map((c) => c.line);
  const toAnnul = classified.filter((c) => c.kind === "dropped").map((c) => c.line);
  const result: CcFeedMirrorResult = {
    window_start: opts.windowStartIso,
    currencies: [...currencies].sort(),
    proof: opts.proof,
    removed: restated.map(mirrorRemovedRow),
    annulled: [],
  };
  return { result, plan: { deleteLineIds: restated.map((l) => l.id), carry: [] }, toAnnul };
}
