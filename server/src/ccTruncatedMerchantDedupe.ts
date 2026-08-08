/**
 * Drop open-bucket lines that are a truncated re-listing of a fuller line.
 *
 * The unbilled month is written by two sources that describe the SAME transaction differently:
 * the nightly scraper feed carries the bank's full merchant string, while a manual paste from
 * Santander's web table carries the merchant cut at exactly **15 characters**. The one-shot dedupe
 * key is `merchant | amount | date`, so the two never collide and both survive — and the bank
 * usually restates the transaction a day later too, so even the dates differ:
 *
 *     MERPAGO*PLANOUT            30/07  US$xxx,xx   (paste, truncated)
 *     MERPAGO*PLANOUTCANALDEVEN  31/07  US$xxx,xx   (feed, settled)
 *     ANTHROPIC* CLAU            01/08  US$xxx,xx   (paste, truncated)
 *     ANTHROPIC* CLAUDE SUB      02/08  US$xxx,xx   (feed, settled)
 *
 * The signature is deliberately narrow: the shorter merchant must be EXACTLY at the web table's
 * truncation width and a STRICT prefix of the longer one, the amounts must match to the cent in
 * the same currency, and the dates must be within a few days. A genuine repeat charge cannot
 * satisfy all four (its merchant string would be identical, not a proper prefix at width 15).
 *
 * It only ever fires when BOTH rows are present, so a paste made before the scraper has seen the
 * transaction is untouched — it is the sole evidence then, and correct to keep.
 *
 * Deletion, not merge: the truncated row carries no field the fuller one lacks.
 */
import { db } from "./db.js";
import { earliestTransactionDateForLineIds } from "./ccCrossImportDedupe.js";
import { parseDdMmYyToIso } from "./ccInstallmentPayBy.js";

/** Santander's web movements table cuts «Comercio» at this width. */
export const WEB_PASTE_MERCHANT_TRUNCATION_WIDTH = 15;

/** How far the bank may restate a transaction's date when it settles. */
export const RESTATEMENT_WINDOW_DAYS = 4;

export type TruncatedMerchantDedupeResult = {
  removed_line_ids: number[];
  removed_count: number;
  /** `truncated → full` pairs, for the import report. */
  removed_pairs: string[];
  /** Earliest transaction date removed — the caller's `affectedEvidenceFromYmd`. */
  removed_from_date: string | null;
};

type BucketLine = {
  id: number;
  merchant: string | null;
  amount_clp: number | null;
  amount_usd: number | null;
  transaction_date: string | null;
};

function normalized(merchant: string | null): string {
  return String(merchant ?? "").trim().toUpperCase().replace(/\s+/g, " ");
}

/** Same money, same currency — compared on the leg that is actually populated. */
function sameAmount(a: BucketLine, b: BucketLine): boolean {
  const usdA = Number(a.amount_usd ?? 0);
  const usdB = Number(b.amount_usd ?? 0);
  if (usdA !== 0 || usdB !== 0) return Math.abs(usdA - usdB) < 0.005;
  const clpA = Number(a.amount_clp ?? 0);
  const clpB = Number(b.amount_clp ?? 0);
  return clpA !== 0 && Math.round(clpA) === Math.round(clpB);
}

function daysApart(a: BucketLine, b: BucketLine): number | null {
  const isoA = parseDdMmYyToIso(String(a.transaction_date ?? ""));
  const isoB = parseDdMmYyToIso(String(b.transaction_date ?? ""));
  if (!isoA || !isoB) return null;
  const ms = Math.abs(Date.parse(`${isoA}T00:00:00Z`) - Date.parse(`${isoB}T00:00:00Z`));
  if (!Number.isFinite(ms)) return null;
  return Math.round(ms / 86_400_000);
}

/**
 * `truncated` is the web table's cut of `full`: exactly the truncation width, and a strict prefix.
 *
 * Equal strings are NOT a match — those are ordinary duplicates the one-shot key already handles,
 * and treating them here would silently delete a genuine second charge of the same amount.
 */
export function isTruncatedMerchantOf(truncated: string, full: string): boolean {
  const t = normalized(truncated);
  const f = normalized(full);
  if (t.length !== WEB_PASTE_MERCHANT_TRUNCATION_WIDTH) return false;
  if (f.length <= t.length) return false;
  return f.startsWith(t);
}

/**
 * Remove truncated re-listings from an account's **web-paste** buckets.
 *
 * Scoped to web-paste sources on purpose: a PDF statement is the bank's own settled record and
 * never carries a truncated merchant, so widening this to statement lines could only add risk.
 */
export function removeTruncatedMerchantDuplicateLines(
  accountId: number
): TruncatedMerchantDedupeResult {
  const lines = db
    .prepare(
      `SELECT l.id, l.merchant, l.amount_clp, l.amount_usd, l.transaction_date
       FROM cc_statement_lines l
       JOIN cc_statements s ON s.id = l.statement_id
       WHERE s.account_id = ? AND s.source_pdf LIKE 'import:web-paste%'`
    )
    .all(accountId) as BucketLine[];

  const removed = new Map<number, string>();
  for (const candidate of lines) {
    if (removed.has(candidate.id)) continue;
    for (const other of lines) {
      if (other.id === candidate.id || removed.has(other.id)) continue;
      if (!isTruncatedMerchantOf(candidate.merchant ?? "", other.merchant ?? "")) continue;
      if (!sameAmount(candidate, other)) continue;
      const gap = daysApart(candidate, other);
      if (gap == null || gap > RESTATEMENT_WINDOW_DAYS) continue;
      removed.set(candidate.id, `${normalized(candidate.merchant)} → ${normalized(other.merchant)}`);
      break;
    }
  }

  const ids = [...removed.keys()];
  if (ids.length === 0) {
    return { removed_line_ids: [], removed_count: 0, removed_pairs: [], removed_from_date: null };
  }

  // Read the evidence date BEFORE deleting — afterwards the rows are gone.
  const removed_from_date = earliestTransactionDateForLineIds(ids);
  const del = db.prepare(`DELETE FROM cc_statement_lines WHERE id = ?`);
  let removed_count = 0;
  db.transaction(() => {
    for (const id of ids) removed_count += del.run(id).changes;
  })();

  return {
    removed_line_ids: ids,
    removed_count,
    removed_pairs: [...removed.values()].sort(),
    removed_from_date,
  };
}
