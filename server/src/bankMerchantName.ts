/**
 * A bank's merchant text as a vendor: the bank's clutter dropped, a payment processor's prefix
 * taken off, and — for category rules — the vendor key: the brand the vendor catalog gives the name
 * (one key for every Jumbo branch), else the cleaned name itself. Pure (no database access): the
 * category-rule migration hook runs it while `db.ts` is loading.
 */
import { WEB_PASTE_MERCHANT_TRUNCATION_WIDTH } from "./ccWebMerchantTruncation.js";
import { foldVendorName, type VendorCatalog } from "./vendorCatalogMatch.js";

const PROCESSOR_PREFIXES: readonly [RegExp, string][] = [
  [/^MERPAGO\s*\*\s*/i, "Mercado Pago"],
  [/^MERCADOPAGO\s*\*\s*/i, "Mercado Pago"],
  [/^MP\s*\*\s*/i, "Mercado Pago"],
  [/^PAYU\s*(?:PS)?\s*\*\s*/i, "PayU"],
  [/^PAYU\s*\/\s*/i, "PayU"],
  [/^HAULMER\s*\*\s*/i, "Haulmer"],
  [/^TUU\s*\*\s*/i, "TUU"],
  [/^SUMUP\s*C?\s*\*\s*/i, "SumUp"],
  [/^REDELCO\s*\*\s*/i, "Redelcom"],
  [/^REDELCOM\s+/i, "Redelcom"],
  [/^FLOW\s*\*\s*/i, "Flow"],
  [/^REDGLOBA\s*\*\s*/i, "RedGlobal"],
  [/^DL\s*\*\s*/i, "dLocal"],
  [/^DP\s*\*\s*/i, "dLocal"],
  [/^PAYPAL\s*\*\s*/i, "PayPal"],
  [/^PYV\s*\*\s*/i, "PYV"],
  [/^NYA\s*\*\s*/i, "Nayax"],
  [/^IZ\s*\*\s*/i, "Zettle"],
  [/^SQ\s*\*\s*/i, "Square"],
];

/** The bank's clutter around a merchant name. */
export function cleanBankMerchant(raw: string): string {
  return raw
    .replace(/\s+COMPRAS P\.A\.T\.\s*$/i, "")
    .replace(/\s*\(T\)\s*$/, "")
    .replace(/,\s*SANTIAGO\s*$/i, "")
    .replace(/^\d{6,}\s+/, "")
    .replace(/^Agustinas\s+/i, "")
    .replace(/^\*\/\s*/, "")
    // An old card listing put «COMPRA» / «Compra Nacional» before the merchant; the statement's
    // own estimated lines («COMPRAS DEL PERIODO (ESTIMADO)») and «Compras Internet» keep theirs.
    .replace(/^Compra Nacional\s+/i, "")
    .replace(/^COMPRAS?\s+(?!DEL PERIODO|INTERNACIONALES|INTERNET\s*$)(?=\S)/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** «MERPAGO*MICOCACOLA» → {name: «MICOCACOLA», processor: «Mercado Pago»}. */
export function splitProcessorPrefix(name: string): { name: string; processor: string | null } {
  for (const [re, processor] of PROCESSOR_PREFIXES) {
    const rest = name.replace(re, "");
    if (rest !== name && rest.trim()) return { name: rest.trim(), processor };
  }
  return { name, processor: null };
}

/**
 * The vendor a category rule is keyed on: the catalog's brand for the name (a branch entry's brand
 * without its branch: «JUMBO BILBAO» and «JUMBO PENALOLEN» are one «JUMBO»), else the cleaned name
 * without its processor prefix, folded.
 */
export function vendorRuleKey(raw: string, catalog: VendorCatalog): string {
  const cleaned = cleanBankMerchant(raw);
  const { name } = splitProcessorPrefix(cleaned);
  const m = catalog.match(name) ?? catalog.match(cleaned);
  return foldVendorName(m ? m.brand : name);
}

/**
 * Rule keys that describe this merchant, most specific first: its vendor key, and the key of its cut
 * at the web table's width. A rule learned on a pasted or pending line carries the cut name
 * («FULLNEUMATICO Q»), and the statement that replaces the line prints the full one.
 */
export function vendorRuleKeyCandidates(raw: string, catalog: VendorCatalog): string[] {
  const full = vendorRuleKey(raw, catalog);
  if (!full) return [];
  const out = [full];
  const base = cleanBankMerchant(raw).replace(/\s+/g, " ");
  if (base.length > WEB_PASTE_MERCHANT_TRUNCATION_WIDTH) {
    const cut = vendorRuleKey(base.slice(0, WEB_PASTE_MERCHANT_TRUNCATION_WIDTH).trimEnd(), catalog);
    if (cut) out.push(cut);
  }
  return [...new Set(out)];
}
