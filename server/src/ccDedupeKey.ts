import crypto from "node:crypto";

/** Align with `norm_merchant` in parse-cc-statement-pdfs.py */
export function normCcMerchant(merchant: string): string {
  return String(merchant ?? "")
    .trim()
    .toUpperCase()
    .replace(/\s+/g, " ");
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
