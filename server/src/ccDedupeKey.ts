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
 * Python parser keeps its own copy of the rule.
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

/** What a line's import dedupe keys are made of (a canonical line, or a stored line read back). */
export type CcLineDedupeKeyInput = {
  installment: boolean;
  /** The line's day (transaction, else posting), ISO. */
  dateIso: string | null;
  merchant: string;
  /** The line's pesos (0 for a dollar line). */
  amountClp: number;
  /** The document's own dedupe key, when it carries one. */
  documentKey: string | null;
};

/** Canonical dedupe keys for import: the document's key, plus the one-shot key (ISO purchase date). */
export function canonicalCcLineDedupeKeys(cardGroup: string, line: CcLineDedupeKeyInput): string[] {
  const keys = new Set<string>();
  const fromDocument = String(line.documentKey ?? "").trim();
  if (fromDocument) keys.add(fromDocument);
  if (line.installment) return [...keys];
  if (!Number.isFinite(line.amountClp) || line.amountClp <= 0) return [...keys];
  if (!line.dateIso) return [...keys];
  keys.add(ccOneShotDedupeKey(cardGroup, line.merchant, Math.trunc(line.amountClp), line.dateIso));
  return [...keys];
}
