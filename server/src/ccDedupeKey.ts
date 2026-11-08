import { normalizeMerchantText } from "nw-tracker-contracts";
import crypto from "node:crypto";

/** Align with `norm_merchant` in parse-cc-statement-pdfs.py */
export function normCcMerchant(merchant: string): string {
  return normalizeMerchantText(merchant);
}

function sha1Hex16(payload: string): string {
  return crypto.createHash("sha1").update(payload).digest("hex").slice(0, 16);
}

/** One-shot line key — same formula as `row_dedupe_key` for non-installment rows. */
export function ccOneShotDedupeKey(
  cardGroup: string,
  merchant: string,
  amountClp: number,
  dateIso: string
): string {
  const m = normCcMerchant(merchant);
  return sha1Hex16(`${cardGroup}|one|${m}|${amountClp}|${dateIso}`);
}

export function ccSha1Hex16(payload: string): string {
  return sha1Hex16(payload);
}

/**
 * Same-statement twins: the parser keeps identical lines apart with a `#dupN` suffix on the Nth
 * occurrence (N ≥ 1). This is the one place the suffix is written and the one place it is read; the
 * Python parser's own copy is pinned by `server/contracts/data/ccDedupeKeyCases.json`.
 */
export function dedupeKeyWithOccurrence(base: string, occurrence: number): string {
  if (!Number.isInteger(occurrence) || occurrence < 0) throw new Error(`dedupe occurrence must be a whole number ≥ 0, got ${occurrence}`);
  return occurrence === 0 ? base : `${base}#dup${occurrence}`;
}

/** Which occurrence a dedupe key names: 0 for the first line, N for `…#dupN`. */
export function dedupeKeyOccurrence(key: string | null | undefined): number {
  const m = /#dup(\d+)$/.exec(String(key ?? "").trim());
  return m ? Number(m[1]) : 0;
}

/** Whether a dedupe key is a same-statement twin's (`#dupN`, N ≥ 1). */
export function isTwinDedupeKey(key: string | null | undefined): boolean {
  return dedupeKeyOccurrence(key) > 0;
}

/**
 * Occurrence-indexes a list of base keys: the Nth identical base gets `#dupN`, in list order. The
 * counter is local to the call — one statement's lines, or one listing.
 */
export function dedupeKeysByOccurrence(bases: readonly string[]): string[] {
  const seen = new Map<string, number>();
  return bases.map((base) => {
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    return dedupeKeyWithOccurrence(base, n);
  });
}

/** A statement-JSON line's base key, in the `json|` key space (no occurrence suffix yet). */
export function ccJsonStatementLineBaseKey(
  cardGroup: string,
  currency: "clp" | "usd",
  dateIso: string,
  merchant: string,
  amountKey: string
): string {
  return `json|${sha1Hex16(`${cardGroup}|${currency}|${dateIso}|${normCcMerchant(merchant)}|${amountKey}`)}`;
}
