/**
 * What an expense row shows as names (2026-10-31): the merchant as a person reads it, and the
 * short label of what the line is linked to. Display only — the line's `merchant` (which merchant
 * rules, the receipt matcher and the real-estate matcher read) stays the bank's text, and the
 * full link detail stays on `payment_receipt` / `transfer_counterparty` for the ⓘ card.
 *
 * Merchant (`display_merchant`, set when it differs from `merchant`):
 *   - a checking transfer whose mail names its counterparty: «Transf a <label>» / «Transf. de <label>»
 *     (the bank's own wording is cut — «Transf a INMOBILIARIA Y CONSTR» — or names nobody)
 *   - else the bank's clutter dropped (BCI's « (T)», the PDF's glued «COMPRAS P.A.T.» column,
 *     «, SANTIAGO», an account number or the old «Agustinas » branch at the start), the payment
 *     processor's prefix taken off («MERPAGO*», «PAYU *», «HAULMER*»… → `merchant_processor`),
 *     then the vendor catalog (`vendorCatalog.ts`); a card merchant the listing cut reads as the
 *     longer merchant it starts on the same account, when they all read the same
 *   - a name the catalog does not know, with a shop's or processor's own receipt: the receipt's payee
 *   - a payslip line: its label spelled, its employer without the legal suffix
 *
 * Link label (`link_label`):
 *   - a receipt: the payee, never the processor («Streat Burger (Isidora)», not «… (Uber Eats)»);
 *     the catalog first; « - X» and a known brand followed by a branch read «Brand (X)»; legal
 *     suffixes off; MercadoLibre sellers title-cased, the first one + «+N»; a URL its host; an
 *     e-mail or a processor placeholder nothing; a stay its city (+ nights)
 *   - an App Store app: the name before its tagline («Grindr - Gay Dating & Chat» → «Grindr»)
 *   - a transfer: the catalog by RUT, else the name the RUT is known by (one written in lower or
 *     mixed case — a contact the user named — over the bank's capitals, then the most frequent),
 *     the catalog by name, then a company without its legal suffix or a person's first name +
 *     first surname, title-cased
 *   - `inline`: false when the shown merchant already contains the label (no repeating it on the row)
 */
import { db } from "./db.js";
import type { FlowCcExpenseLineRow } from "./flowsExpenses.js";
import type { TransferCounterpartyDto } from "./bankTransferNotices.js";
import type { PaymentReceiptDto } from "./paymentProcessorReceipts.js";
import {
  hostOfUrl,
  isEmailAddress,
  isPlaceholderPayee,
  looksLikeCompany,
  shortPersonName,
  stripLegalSuffix,
  titleCaseName,
  trimNameEdges,
} from "./expenseNameText.js";
import { repairMojibake } from "./textRepair.js";
import { WEB_PASTE_MERCHANT_TRUNCATION_WIDTH } from "./ccWebMerchantTruncation.js";
import { cleanBankMerchant, splitProcessorPrefix } from "./bankMerchantName.js";
import { linkKeyForName, type CategoryRuleLink } from "./expenseCategoryRules.js";

export { cleanBankMerchant, splitProcessorPrefix };
import { foldVendorName, loadVendorCatalog, normalizeRut, type VendorCatalog } from "./vendorCatalog.js";

export type ExpenseLinkLabel = {
  /** «→» paid to, «≈» an inferred link, «←» received from, «⇄» between own products. */
  arrow: "→" | "≈" | "←" | "⇄";
  text: string;
  /** A stay's nights (lodging receipts); the client words it. */
  nights: number | null;
  /** Show it on the row beside the merchant (false when the merchant already says it). */
  inline: boolean;
};

export type ExpenseDisplayNames = {
  display_merchant?: string;
  merchant_processor?: string;
  link_label?: ExpenseLinkLabel;
  /** A cut branch that could be several places: the user picks one (`key`: the folded name). */
  branch_choices?: { key: string; options: string[] };
  /** What a specific category rule for this line is keyed on (`expenseCategoryRules.ts`). */
  category_link?: CategoryRuleLinkDto;
};

/**
 * The line's link as a category rule sees it: a receipt's store (by brand), an App Store app, or a
 * transfer's recipient (by RUT, else by name). `specific_default`: whether a category change writes
 * the specific rule unless the user says otherwise — off for food delivery (the restaurant does not
 * change what the platform is), on for everything else.
 */
export type CategoryRuleLinkDto = CategoryRuleLink & { label: string; specific_default: boolean };

const FOOD_DELIVERY_RECEIPTS = new Set(["uber_eats", "uber_eats_summary", "rappi"]);

/**
 * Receipts of the shop itself or of a payment processor: their payee is the merchant the bank's
 * name hides («COMERCIALLASI» → «Corrales del Sur»). Platforms selling for others (Uber Eats,
 * MercadoLibre, the App Store, stays) keep the platform as the merchant and the payee as the link.
 */
const RECEIPT_NAMES_MERCHANT = new Set([
  "shopify",
  "flow",
  "pago_facil",
  "calvin_klein",
  "adidas",
  "dynavap",
  "club_domino",
  "micoca_cola",
]);

/** «Grindr - Gay Dating & Chat», «Tinder Dating App: Meet & Date + Grindr - …» → «Grindr», «Tinder + Grindr». */
export function appStoreLabel(name: string, catalog: VendorCatalog): string {
  const apps = name
    .split(/\s\+\s/)
    .map((app) => {
      const short = stripLegalSuffix(app.split(/ - | – |: |, | \(/)[0]!.trim());
      return catalog.lookup(app) ?? catalog.lookup(short) ?? short;
    })
    .filter(Boolean);
  return [...new Set(apps)].join(" + ");
}

/** Brands receipts print with a branch («Streat Burger - Isidora», «La Birra Bar (Lira)»). */
export function brandsFromPayees(payees: Iterable<string>): string[] {
  const brands = new Set<string>();
  for (const p of payees) {
    const m = /^(.+?)\s+-\s+\S/.exec(p) ?? /^(.+?)\s*\([^)]+\)\s*$/.exec(p);
    const brand = m ? trimNameEdges(m[1]!) : "";
    if (brand.length >= 4) brands.add(brand);
  }
  return [...brands].sort((a, b) => b.length - a.length);
}

const LODGING_PROCESSORS = new Set(["booking", "airbnb", "stripe", "accor"]);

function nightsBetween(checkIn: string, checkOut: string): number | null {
  const a = Date.parse(`${checkIn}T00:00:00Z`);
  const b = Date.parse(`${checkOut}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b) || b <= a) return null;
  return Math.round((b - a) / 86_400_000);
}

/** The short label of a receipt's payee; null when it names nobody. */
export function receiptLabel(
  r: Pick<PaymentReceiptDto, "processor" | "payee" | "stay">,
  catalog: VendorCatalog,
  brands: readonly string[]
): { text: string; nights: number | null } | null {
  if (LODGING_PROCESSORS.has(r.processor) && r.stay?.city) {
    return { text: r.stay.city, nights: nightsBetween(r.stay.check_in, r.stay.check_out) };
  }
  if (r.processor === "app_store") return { text: appStoreLabel(r.payee, catalog), nights: null };
  const payee = repairMojibake(r.payee).trim();
  if (!payee || isEmailAddress(payee) || isPlaceholderPayee(payee)) return null;
  const host = hostOfUrl(payee);
  if (host) return { text: catalog.lookup(host) ?? host, nights: null };
  const direct = catalog.lookup(payee);
  if (direct) return { text: direct, nights: null };
  if (r.processor === "mercadolibre") {
    const sellers = payee.split(/,\s*/).filter(Boolean);
    const first = sellers[0]!;
    const label = catalog.lookup(first) ?? titleCaseName(stripLegalSuffix(first));
    return { text: sellers.length > 1 ? `${label} +${sellers.length - 1}` : label, nights: null };
  }
  let text = trimNameEdges(payee).replace(/^(.+?)\s+-\s+(.+)$/, "$1 ($2)");
  if (!text.includes("(")) {
    const folded = foldVendorName(text);
    const brand = brands.find((b) => folded.startsWith(`${foldVendorName(b)} `));
    if (brand) text = `${brand} (${text.slice(brand.length).trim()})`;
  }
  text = stripLegalSuffix(text);
  if (text === text.toUpperCase()) text = titleCaseName(text);
  return { text: catalog.lookup(text) ?? text, nights: null };
}

/** `RUT` → the name it is known by; `name:<folded>` for counterparties no mail gave a RUT. */
export type CounterpartyNames = Map<string, string>;

/**
 * The name each counterparty is known by, over every stored notice: a name written in lower or
 * mixed case (a contact the user saved) over the bank's capitals, then the most frequent, then the
 * latest.
 */
export function loadCounterpartyNames(): CounterpartyNames {
  const rows = db
    .prepare(
      `SELECT CASE WHEN kind = 'incoming' THEN from_rut ELSE to_rut END AS rut,
              CASE WHEN kind = 'incoming' THEN from_name ELSE to_name END AS name,
              COUNT(*) AS n, MAX(notice_date) AS last
       FROM bank_transfer_notices
       WHERE kind <> 'between_own_products'
       GROUP BY 1, 2`
    )
    .all() as { rut: string | null; name: string | null; n: number; last: string }[];
  return counterpartyNamesFromRows(rows);
}

export function counterpartyNamesFromRows(
  rows: readonly { rut: string | null; name: string | null; n: number; last: string }[]
): CounterpartyNames {
  const best = new Map<string, { name: string; score: [number, number, string] }>();
  for (const r of rows) {
    const name = repairMojibake(r.name ?? "").trim();
    if (!name || !r.rut) continue;
    const key = normalizeRut(r.rut);
    const letters = name.replace(/[^\p{L}]/gu, "");
    const ownSpelling = letters !== letters.toUpperCase() ? 1 : 0;
    const score: [number, number, string] = [ownSpelling, r.n, r.last];
    const cur = best.get(key);
    const better =
      !cur ||
      score[0] > cur.score[0] ||
      (score[0] === cur.score[0] && (score[1] > cur.score[1] || (score[1] === cur.score[1] && score[2] > cur.score[2])));
    if (better) best.set(key, { name, score });
  }
  return new Map([...best].map(([k, v]) => [k, v.name]));
}

/** The short label of a transfer counterparty; null when the mail names nobody. */
export function counterpartyLabel(
  c: Pick<TransferCounterpartyDto, "name" | "rut">,
  catalog: VendorCatalog,
  names: CounterpartyNames
): string | null {
  const byRut = catalog.lookupRut(c.rut);
  if (byRut) return byRut;
  const known = (c.rut ? names.get(normalizeRut(c.rut)) : null) ?? repairMojibake(c.name ?? "").trim();
  if (!known) return null;
  const listed = catalog.lookup(known) ?? (c.name ? catalog.lookup(c.name) : null);
  if (listed) return listed;
  if (looksLikeCompany(known)) return titleCaseName(stripLegalSuffix(known));
  return shortPersonName(titleCaseName(known));
}

function contains(haystack: string, needle: string): boolean {
  const h = foldVendorName(haystack);
  const n = foldVendorName(needle);
  return n.length > 0 && h.includes(n);
}

export type DisplayNameContext = {
  catalog: VendorCatalog;
  counterparties: CounterpartyNames;
  brands: readonly string[];
  /** Each card account's merchants as printed (folded, distinct): evidence for a cut name. */
  cardMerchantsByAccount: ReadonlyMap<number, readonly string[]>;
};

/** The folded merchants each card account's lines print. */
export function cardMerchantsByAccount(
  lines: readonly Pick<FlowCcExpenseLineRow, "source" | "merchant" | "account_id">[]
): Map<number, string[]> {
  const sets = new Map<number, Set<string>>();
  for (const l of lines) {
    if (l.source !== "cc" || !l.merchant) continue;
    const folded = foldVendorName(l.merchant);
    if (!folded) continue;
    let set = sets.get(l.account_id);
    if (!set) sets.set(l.account_id, (set = new Set()));
    set.add(folded);
  }
  return new Map([...sets].map(([k, v]) => [k, [...v]]));
}

export function loadDisplayNameContext(
  lines: readonly Pick<FlowCcExpenseLineRow, "payment_receipt" | "source" | "merchant" | "account_id">[]
): DisplayNameContext {
  const payees = lines.flatMap((l) =>
    l.payment_receipt && l.payment_receipt.processor !== "app_store" ? [l.payment_receipt.payee] : []
  );
  return {
    catalog: loadVendorCatalog(),
    counterparties: loadCounterpartyNames(),
    brands: brandsFromPayees(payees),
    cardMerchantsByAccount: cardMerchantsByAccount(lines),
  };
}

/** A bank merchant through the catalog: cleaned, processor prefix off, then looked up. */
function catalogMerchant(
  raw: string,
  catalog: VendorCatalog
): { name: string; processor: string | null; listed: string | null; choices: ExpenseDisplayNames["branch_choices"] | null } {
  const cleaned = cleanBankMerchant(raw);
  const { name, processor } = splitProcessorPrefix(cleaned);
  for (const key of [name, cleaned]) {
    const m = catalog.match(key);
    if (m) {
      const choices = m.branchChoices ? { key: foldVendorName(key), options: m.branchChoices } : null;
      return { name, processor, listed: m.display, choices };
    }
  }
  return { name, processor, listed: null, choices: null };
}

const PAYSLIP_LABEL_WORDS: readonly [RegExp, string][] = [
  [/\bUnico\b/g, "Único"],
  [/\bCotizacion\b/g, "Cotización"],
  [/\bComision\b/g, "Comisión"],
];

/** «Impuesto Unico (LQ) · EMPRESA CHILE SPA» → «Impuesto Único · Empresa Chile». */
export function payslipLineName(raw: string): string {
  const parts = raw.split(" · ");
  const employer = parts.length > 1 ? parts.pop()! : null;
  let label = parts.join(" · ").replace(/\s*\(LQ\)\s*$/i, "").trim();
  if (label === label.toUpperCase()) label = titleCaseName(label);
  for (const [re, word] of PAYSLIP_LABEL_WORDS) label = label.replace(re, word);
  return employer ? `${label} · ${titleCaseName(stripLegalSuffix(employer))}` : label;
}

/**
 * A card merchant the bank's listing cut («PAYU *UBER EA»: the web table and the feed's pending
 * rows cut at 15 characters, and the bank collapses spaces before sending it, so the stored length
 * says nothing) shows as the longer merchant it starts — when the same account's lines print one —
 * if every such merchant reads the same through the catalog. Null when none does, or they differ.
 */
function cutMerchantListed(raw: string, accountId: number, ctx: DisplayNameContext): string | null {
  const folded = foldVendorName(raw);
  if (!folded || folded.length > WEB_PASTE_MERCHANT_TRUNCATION_WIDTH) return null;
  const longer = (ctx.cardMerchantsByAccount.get(accountId) ?? []).filter(
    (m) => m.length > folded.length && m.startsWith(folded)
  );
  if (longer.length === 0) return null;
  const listed = new Set(longer.map((m) => catalogMerchant(m, ctx.catalog).listed));
  if (listed.size !== 1) return null;
  return [...listed][0] ?? null;
}

/** The names one line shows. */
export function expenseLineDisplayNames(
  line: Pick<FlowCcExpenseLineRow, "source" | "merchant" | "account_id" | "payment_receipt" | "transfer_counterparty">,
  ctx: DisplayNameContext
): ExpenseDisplayNames {
  const out: ExpenseDisplayNames = {};
  const raw = line.merchant ?? "";
  const cp = line.transfer_counterparty;
  const cpLabel = cp ? counterpartyLabel(cp, ctx.catalog, ctx.counterparties) : null;

  let shown = raw;
  if (line.source === "checking" && cp && cpLabel && cp.direction !== "own") {
    shown = cp.direction === "out" ? `Transf a ${cpLabel}` : `Transf. de ${cpLabel}`;
  } else if (line.source === "payslip" && raw) {
    shown = payslipLineName(raw);
  } else if (raw) {
    const { name, processor, listed, choices } = catalogMerchant(raw, ctx.catalog);
    const known = listed ?? (line.source === "cc" ? cutMerchantListed(raw, line.account_id, ctx) : null);
    shown = known ?? name;
    if (processor) out.merchant_processor = processor;
    if (choices) out.branch_choices = choices;
    // A shop's or processor's receipt names the merchant the bank's name hides.
    const r = line.payment_receipt;
    if (known == null && r && !r.guess && RECEIPT_NAMES_MERCHANT.has(r.processor)) {
      const label = receiptLabel(r, ctx.catalog, ctx.brands);
      if (label) shown = label.text;
    }
  }
  if (shown && shown !== raw) out.display_merchant = shown;

  const r = line.payment_receipt;
  if (r) {
    const label = receiptLabel(r, ctx.catalog, ctx.brands);
    if (label) {
      out.link_label = { arrow: r.guess ? "≈" : "→", text: label.text, nights: label.nights, inline: !contains(shown, label.text) };
      // A stay's label is its city: no rule per city.
      if (label.nights == null && !LODGING_PROCESSORS.has(r.processor)) {
        const app = r.processor === "app_store";
        const key = linkKeyForName(label.text);
        if (key) {
          out.category_link = {
            kind: app ? "app" : "receipt",
            key,
            label: label.text,
            specific_default: app || !FOOD_DELIVERY_RECEIPTS.has(r.processor),
          };
        }
      }
    }
  } else if (cp && cpLabel) {
    const arrow = cp.direction === "out" ? "→" : cp.direction === "in" ? "←" : "⇄";
    out.link_label = { arrow, text: cpLabel, nights: null, inline: !contains(shown, cpLabel) };
    if (cp.direction !== "own") {
      const key = cp.rut ? normalizeRut(cp.rut) : `N:${foldVendorName(cp.name ?? cpLabel)}`;
      out.category_link = { kind: "recipient", key, label: cpLabel, specific_default: true };
    }
  }
  return out;
}

/** Every line with the names it shows (last step of the expense lines). */
export function withExpenseDisplayNames<L extends FlowCcExpenseLineRow>(lines: L[]): L[] {
  if (lines.length === 0) return lines;
  const ctx = loadDisplayNameContext(lines);
  return lines.map((l) => {
    const names = expenseLineDisplayNames(l, ctx);
    return Object.keys(names).length > 0 ? { ...l, ...names } : l;
  });
}
