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
  listingLineAmount,
  listingLineCurrency,
  listOpenBucketLines,
  merchantsSame,
  type CcOpenBucketLine,
} from "./ccFeedCuotaPurchases.js";
import { daysBetweenIso } from "nw-tracker-contracts";
import { isCardPaymentLine } from "./ccPaymentLines.js";
import type { CcListingLine } from "./ccWebPasteParse.js";
import { isHomeCurrency, roundToCurrency } from "./displayUnits.js";
import { sameCoin } from "./matching/money.js";
import { pairOneToOne } from "./matching/pairing.js";
import { MATCH_WINDOWS } from "./matching/windows.js";

export const MIRROR_MAX_DELETIONS = 12;

export type CcFeedMirrorRemoved = {
  id: number;
  date: string;
  merchant: string | null;
  /** The line's amount in its own currency. */
  amount: number | null;
  currency: string;
  /** The same amount in the report's peso / dollar keys (null for a line in any other currency). */
  amount_clp: number | null;
  amount_usd: number | null;
};

/** How a currency's listing was proved complete, so its missing lines may be removed. */
export type FeedMirrorCurrencyProof = "saldo_inicial" | "cupo_identity";

/** What proved each mirrored currency's listing complete, by currency code. */
export type FeedMirrorProof = Readonly<Record<string, FeedMirrorCurrencyProof>>;

/** An unlisted line kept as an annulled purchase (`ccAnnulledPurchases.ts`) instead of deleted. */
export type CcFeedMirrorAnnulled = CcFeedMirrorRemoved & {
  /** The `cc_annulled_purchases` row written for it. */
  annulled_purchase_id: number;
  basis: "feed_drop" | "cupo_gap";
};

export type CcFeedMirrorResult = {
  window_start: string;
  currencies: string[];
  /** Per mirrored currency, what proved its listing complete. */
  proof: FeedMirrorProof;
  /** Restatements deleted: the bank re-listed the purchase under another amount, name or date. */
  removed: CcFeedMirrorRemoved[];
  /** Lines the bank dropped without restating them: kept as purchase + annulment. */
  annulled: CcFeedMirrorAnnulled[];
};

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
  stated: ReadonlySet<string>;
  /** The close on record for the card (the listing's, or the latest recorded), with its billed total per currency. */
  closeOnRecord: { saldo_inicial: Readonly<Record<string, number | null>> } | null;
  /** Every listed row, debt-positive, as the feeder sent it. */
  lines: readonly { currency: string; amount: number }[];
  /** The bank's cupo utilizado per currency, from the same session's product summary. */
  bankUsed: Readonly<Record<string, number>>;
}): FeedMirrorProof {
  const proof: Record<string, FeedMirrorCurrencyProof> = {};
  // Every currency either side names: a slide that stated its close, or a cupo the bank reported.
  for (const currency of [...new Set([...opts.stated, ...Object.keys(opts.bankUsed)])].sort()) {
    if (opts.stated.has(currency)) {
      proof[currency] = "saldo_inicial";
      continue;
    }
    const saldoInicial = opts.closeOnRecord?.saldo_inicial[currency];
    const used = opts.bankUsed[currency];
    if (saldoInicial == null || used == null) continue;
    // Each figure to the currency's coin, then their sum against the bank's, to the coin.
    const listed = opts.lines
      .filter((l) => l.currency === currency)
      .reduce((sum, l) => sum + roundToCurrency(l.amount, currency), 0);
    if (sameCoin(roundToCurrency(saldoInicial, currency) + listed, used, currency)) {
      proof[currency] = "cupo_identity";
    }
  }
  return proof;
}

/** Bucket lines of the mirrored window that no feed row accounts for (read-only planner). */
export function planFeedMirror(
  accountId: number,
  opts: { windowStartIso: string; currencies: ReadonlySet<string>; feedLines: readonly CcListingLine[] }
): CcOpenBucketLine[] {
  return pairBucketWithFeed(accountId, opts).unlisted;
}

/**
 * The mirrored window's bucket lines against the listing (read-only): the lines no row accounts
 * for, and for each row that accounts for one, that line (`listedAs`: the row's own line on file).
 */
export function pairBucketWithFeed(
  accountId: number,
  opts: { windowStartIso: string; currencies: ReadonlySet<string>; feedLines: readonly CcListingLine[] }
): { unlisted: CcOpenBucketLine[]; listedAs: Map<CcListingLine, CcOpenBucketLine> } {
  const candidates = listOpenBucketLines(accountId).filter((line) => {
    if (line.installment_flag) return false;
    if (!opts.currencies.has(listingLineCurrency(line))) return false;
    if (isCardPaymentLine(line)) return false;
    const iso = bucketLinePurchaseIso(line);
    return iso != null && iso >= opts.windowStartIso;
  });
  const feed = opts.feedLines.filter((f) => opts.currencies.has(f.currency));
  // Exact-date matches first, so a same-amount purchase a few days later can't steal the row; each
  // pass pairs the first fitting row (the feed's own order — not the nearest, kept as it was).
  let unlisted = [...candidates];
  let freeFeed = [...feed];
  const listedAs = new Map<CcListingLine, CcOpenBucketLine>();
  for (const maxDayGap of [0, MATCH_WINDOWS.feed_mirror.daysAfter]) {
    const pass = pairOneToOne(unlisted, freeFeed, {
      strategy: "first",
      accepts: (line, f) => bucketLineMatchesFeedLine(line, f, maxDayGap),
    });
    for (const pair of pass.pairs) listedAs.set(pair.right, pair.left);
    unlisted = pass.unpaired;
    freeFeed = pass.unclaimed;
  }
  return { unlisted, listedAs };
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
 *
 * `listedAs` names the listed row a restated line became, when the listing leaves no doubt: the
 * one free row of its amount in the window. That row's own line on file then takes over the
 * deleted line's flow (`planOpenBucketMirror`), so what the app knew of the purchase — when it
 * first arrived, its category, note, big group — stays with it. Two candidate rows name none (the
 * line is deleted as before), and a re-settlement never carries: the other amount may be another
 * purchase at the same shop, and pieces filed on the old amount would not fit the new one.
 */
export type UnlistedLineKind = "re_settlement" | "restatement" | "credit" | "dropped";

export function classifyUnlistedLines(
  unlisted: readonly CcOpenBucketLine[],
  feedLines: readonly CcListingLine[]
): { line: CcOpenBucketLine; kind: UnlistedLineKind; listedAs?: CcListingLine }[] {
  const window = MATCH_WINDOWS.feed_mirror.daysAfter;
  const taken = new Set<number>();
  return unlisted.map((line) => {
    const iso = bucketLinePurchaseIso(line);
    const currency = listingLineCurrency(line);
    const own = listingLineAmount(line) ?? 0;
    if (!own || own < 0) {
      return { line, kind: "credit" as const };
    }
    const amount = Math.abs(own);
    const sameAmount = (f: CcListingLine): boolean => sameCoin(Math.abs(f.amount), amount, currency);
    const nearIdx: number[] = [];
    feedLines.forEach((f, i) => {
      if (f.currency === currency && iso != null && Math.abs(daysBetweenIso(iso, f.transaction_date)) <= window) nearIdx.push(i);
    });
    if (nearIdx.some((i) => !sameAmount(feedLines[i]!) && merchantsSame(line.merchant, feedLines[i]!.merchant))) {
      return { line, kind: "re_settlement" as const };
    }
    const restating = nearIdx.filter((i) => {
      const f = feedLines[i]!;
      return !taken.has(i) && sameAmount(f) && !(f.transaction_date === iso && merchantsSame(line.merchant, f.merchant));
    });
    const hit = restating[0];
    if (hit != null) {
      taken.add(hit);
      return restating.length === 1
        ? { line, kind: "restatement" as const, listedAs: feedLines[hit]! }
        : { line, kind: "restatement" as const };
    }
    return { line, kind: "dropped" as const };
  });
}

export function mirrorRemovedRow(l: CcOpenBucketLine): CcFeedMirrorRemoved {
  return {
    id: l.id,
    date: bucketLinePurchaseIso(l) ?? String(l.transaction_date ?? ""),
    merchant: l.merchant,
    amount: listingLineAmount(l),
    currency: listingLineCurrency(l),
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
          return `${r.date} ${r.merchant} ${isHomeCurrency(r.currency) ? r.amount : `${r.currency.toUpperCase()} ${r.amount}`}`;
        })
        .join("; ")
  );
}

/**
 * The lines the bank dropped from its listing (read-only planner): restatements to delete
 * (`plan`), the rest to annul (`toAnnul`; the caller writes the annulments and applies the
 * deletions in one card-line write). More than {@link MIRROR_MAX_DELETIONS} lines in all throws.
 *
 * A deleted line the listing restates under exactly one other row is carried onto that row's
 * line (`plan.carry` → `adoptReplacingCardLines`), each row's line taking one deleted line at
 * most: a boleta's line («EXPRESS LYON») the bank listed under its acquirer's name («SUPERMERCADO
 * PLAZA LYON LTDA.») used to be deleted beside a brand-new line, so the purchase read as arriving
 * again when the bank listed it (2026-11-26) and anything filed on the first line was lost.
 */
export function planOpenBucketMirror(
  accountId: number,
  opts: {
    windowStartIso: string;
    proof: FeedMirrorProof;
    feedLines: readonly CcListingLine[];
  }
): { result: CcFeedMirrorResult; plan: CardLinePlan; toAnnul: CcOpenBucketLine[] } {
  const currencies = new Set(Object.keys(opts.proof));
  const { unlisted, listedAs } = pairBucketWithFeed(accountId, {
    windowStartIso: opts.windowStartIso,
    currencies,
    feedLines: opts.feedLines,
  });
  assertMirrorWithinLimit(accountId, opts.windowStartIso, unlisted);
  const classified = classifyUnlistedLines(unlisted, opts.feedLines);
  const restated = classified.filter((c) => c.kind !== "dropped").map((c) => c.line);
  const carry: { fromLineId: number; toLineId: number }[] = [];
  const carriedOnto = new Set<number>();
  for (const c of classified) {
    const onto = c.listedAs ? listedAs.get(c.listedAs) : undefined;
    if (!onto || carriedOnto.has(onto.id)) continue;
    carriedOnto.add(onto.id);
    carry.push({ fromLineId: c.line.id, toLineId: onto.id });
  }
  const toAnnul = classified.filter((c) => c.kind === "dropped").map((c) => c.line);
  const result: CcFeedMirrorResult = {
    window_start: opts.windowStartIso,
    currencies: [...currencies].sort(),
    proof: opts.proof,
    removed: restated.map(mirrorRemovedRow),
    annulled: [],
  };
  return { result, plan: { deleteLineIds: restated.map((l) => l.id), carry }, toAnnul };
}
