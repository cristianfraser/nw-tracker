/**
 * Drop open-bucket lines that re-list a fuller line of the same transaction.
 *
 * The unbilled month is written by sources that describe the SAME transaction at different
 * merchant widths. The one-shot dedupe key is `merchant | amount | date`, so the two renderings
 * never collide and both survive — the open month over-reports. Two signatures are known:
 *
 * 1. **Truncated merchant (2026-08-06).** Santander's web movements table — and, since
 *    2026-08-28, the nightly feed's PENDING-AUTHORIZATION rows — carry the merchant name cut at
 *    exactly **15 characters**; the settled row (feed, a day or two later) carries the full name.
 *    The bank sometimes restates the date when it settles, so even the dates can differ:
 *
 *        MERPAGO*PLANOUT            30/07  US$xxx,xx   (paste, truncated)
 *        MERPAGO*PLANOUTCANALDEVEN  31/07  US$xxx,xx   (feed, settled)
 *        FARMACITY LA PL            29/08  US$xx,xx    (feed, pending authorization)
 *        FARMACITY LA PLATA 2 4584  29/08  US$xx,xx    (feed, settled)
 *
 * 2. **Pending authorization → settled with terminal code (2026-09-05).** When the merchant
 *    name is SHORTER than the cut, the pending row is the whole short name — not a truncation,
 *    so rule 1 cannot claim it — and the settled row appends the acquirer's 4-digit terminal
 *    code, occasionally after extra words of the clearing name:
 *
 *        CHANA                      30/08  US$xxx,xx   (feed, pending)
 *        CHANA 7142                 30/08  US$xxx,xx   (feed, settled)
 *        BISONTE PALACE             02/09  US$xx,xx    (feed, pending)
 *        BISONTE PALACE HOTEL 4995  02/09  US$xx,xx    (feed, settled)
 *
 *    The pending name must be the settled name's core (everything before ` NNNN`) or a
 *    whole-word prefix of it. Only the spaced ` NNNN` form is recognised: when the settled name
 *    overflows the bank's 25-char field the code is glued on (`LA GUITARRITA CABALLI5080`), but
 *    a name that long was necessarily cut at 15 in its pending row, which is rule 1's domain.
 *
 * Both signatures are deliberately narrow: same amount to the cent in the same currency, and
 * for rule 1 the shorter string EXACTLY at the truncation width with dates within a few days
 * (a manual paste carries the authorization date, the feed's settled row may carry the next
 * day); for rule 2 the settled row must carry the terminal code and the dates must be the SAME
 * day — the feed keeps the date when it settles a pending authorization (13 of 13 pairs
 * observed 2026-08-29 → 09-05), so a short name on another day is a different purchase.
 * **Identical merchants never match**: a genuine repeat charge has the same merchant string,
 * and the one-shot key already handles true duplicates. (The feed's `APPLE.COM/BILL` pending
 * rows restate with the SAME merchant and the date shifted +1 — that pair is left alone on
 * purpose; it self-resolves at the facturación.)
 *
 * It only ever fires when BOTH rows are present — a pending row whose settled twin has not
 * arrived is the sole evidence then, and correct to keep. The pass is idempotent: settled rows
 * never match each other, so re-running after a write finds nothing new.
 *
 * Deletion, not merge: the shorter row carries no field the fuller one lacks.
 */
import { db } from "./db.js";
import { earliestTransactionDateForLineIds } from "./ccCrossImportDedupe.js";
import { parseDdMmYyToIso } from "./ccInstallmentPayBy.js";

/** Santander's web movements table (and the feed's pending rows) cut «Comercio» at this width. */
export const WEB_PASTE_MERCHANT_TRUNCATION_WIDTH = 15;

/** How far the bank may restate a transaction's date when it settles. */
export const RESTATEMENT_WINDOW_DAYS = 4;

export type MerchantDuplicateRule = "truncated" | "pending_authorization";

export type TruncatedMerchantDedupePlan = {
  /** The shorter row that would be removed. */
  line_id: number;
  /** The (closest-dated) fuller row it re-lists. */
  keep_line_id: number;
  rule: MerchantDuplicateRule;
  /** `shorter → fuller`, for the import report. */
  pair: string;
  /** Days between the two rows' transaction dates. */
  gap: number;
};

export type TruncatedMerchantDedupeResult = {
  removed_line_ids: number[];
  removed_count: number;
  /** `shorter → fuller` pairs (rule 2 pairs tagged), for the import report. */
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
 * Rule 1 — `truncated` is the web table's cut of `full`: exactly the truncation width, and a
 * strict prefix.
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

/** A settled international row: `<name> NNNN`, the acquirer's 4-digit terminal code last. */
const SETTLED_TERMINAL_CODE_RE = /^(.+) \d{4}$/;

/**
 * Rule 2 — `pending` is the feed's pending-authorization rendering of `settled`: a merchant
 * name shorter than the truncation width (so rule 1 cannot claim it — a longer name would have
 * been cut), and `settled` is that name, or that name plus further words, followed by ` NNNN`.
 *
 * A pending name at or past the width is never matched here: at exactly 15 it is rule 1's, and
 * the feed never renders a pending name wider than that.
 */
export function isPendingAuthorizationOf(pending: string, settled: string): boolean {
  const p = normalized(pending);
  const s = normalized(settled);
  if (p.length === 0 || p.length >= WEB_PASTE_MERCHANT_TRUNCATION_WIDTH) return false;
  const m = SETTLED_TERMINAL_CODE_RE.exec(s);
  if (!m) return false;
  const core = m[1];
  return core === p || core.startsWith(`${p} `);
}

function merchantDuplicateRule(shorter: string, longer: string): MerchantDuplicateRule | null {
  if (isTruncatedMerchantOf(shorter, longer)) return "truncated";
  if (isPendingAuthorizationOf(shorter, longer)) return "pending_authorization";
  return null;
}

function pairLabel(shorter: BucketLine, longer: BucketLine, rule: MerchantDuplicateRule): string {
  const base = `${normalized(shorter.merchant)} → ${normalized(longer.merchant)}`;
  return rule === "pending_authorization" ? `${base} [pending authorization]` : base;
}

/**
 * Plan (without writing) which of an account's **web-paste** lines re-list a fuller twin.
 *
 * Scoped to web-paste sources on purpose: a PDF statement is the bank's own settled record and
 * never carries a truncated or pending merchant, so widening this to statement lines could only
 * add risk.
 */
export function planTruncatedMerchantDuplicateLines(accountId: number): TruncatedMerchantDedupePlan[] {
  const lines = db
    .prepare(
      `SELECT l.id, l.merchant, l.amount_clp, l.amount_usd, l.transaction_date
       FROM cc_statement_lines l
       JOIN cc_statements s ON s.id = l.statement_id
       WHERE s.account_id = ? AND s.source_pdf LIKE 'import:web-paste%'`
    )
    .all(accountId) as BucketLine[];

  const removed = new Map<number, TruncatedMerchantDedupePlan>();
  for (const shorter of lines) {
    for (const longer of lines) {
      if (longer.id === shorter.id) continue;
      const rule = merchantDuplicateRule(shorter.merchant ?? "", longer.merchant ?? "");
      if (!rule) continue;
      if (!sameAmount(shorter, longer)) continue;
      const gap = daysApart(shorter, longer);
      if (gap == null) continue;
      if (rule === "truncated" ? gap > RESTATEMENT_WINDOW_DAYS : gap !== 0) continue;
      // Report the closest fuller twin; any qualifying twin is enough to remove the shorter row.
      const prev = removed.get(shorter.id);
      if (prev && prev.gap <= gap) continue;
      removed.set(shorter.id, {
        line_id: shorter.id,
        keep_line_id: longer.id,
        rule,
        pair: pairLabel(shorter, longer, rule),
        gap,
      });
    }
  }
  const plan = [...removed.values()].sort((a, b) => a.line_id - b.line_id);
  return plan;
}

/**
 * Remove shorter re-listings from an account's **web-paste** buckets (see the plan above).
 *
 * The caller owns the revaluation: pass `removed_from_date` as `affectedEvidenceFromYmd` to
 * `upsertCreditCardValuationsFromLedger` and recompute the billing balances.
 */
export function removeTruncatedMerchantDuplicateLines(
  accountId: number
): TruncatedMerchantDedupeResult {
  const plan = planTruncatedMerchantDuplicateLines(accountId);
  const ids = plan.map((p) => p.line_id);
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
    removed_pairs: plan.map((p) => p.pair).sort(),
    removed_from_date,
  };
}
