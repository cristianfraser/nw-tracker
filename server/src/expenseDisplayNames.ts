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
 *     then the vendor catalog (`vendorCatalog.ts`)
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
};

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

export type DisplayNameContext = { catalog: VendorCatalog; counterparties: CounterpartyNames; brands: readonly string[] };

export function loadDisplayNameContext(lines: readonly Pick<FlowCcExpenseLineRow, "payment_receipt">[]): DisplayNameContext {
  const payees = lines.flatMap((l) =>
    l.payment_receipt && l.payment_receipt.processor !== "app_store" ? [l.payment_receipt.payee] : []
  );
  return { catalog: loadVendorCatalog(), counterparties: loadCounterpartyNames(), brands: brandsFromPayees(payees) };
}

/** The names one line shows. */
export function expenseLineDisplayNames(
  line: Pick<FlowCcExpenseLineRow, "source" | "merchant" | "payment_receipt" | "transfer_counterparty">,
  ctx: DisplayNameContext
): ExpenseDisplayNames {
  const out: ExpenseDisplayNames = {};
  const raw = line.merchant ?? "";
  const cp = line.transfer_counterparty;
  const cpLabel = cp ? counterpartyLabel(cp, ctx.catalog, ctx.counterparties) : null;

  let shown = raw;
  if (line.source === "checking" && cp && cpLabel && cp.direction !== "own") {
    shown = cp.direction === "out" ? `Transf a ${cpLabel}` : `Transf. de ${cpLabel}`;
  } else if (raw) {
    const cleaned = cleanBankMerchant(raw);
    const { name, processor } = splitProcessorPrefix(cleaned);
    shown = ctx.catalog.lookup(name) ?? ctx.catalog.lookup(cleaned) ?? name;
    if (processor) out.merchant_processor = processor;
  }
  if (shown && shown !== raw) out.display_merchant = shown;

  const r = line.payment_receipt;
  if (r) {
    const label = receiptLabel(r, ctx.catalog, ctx.brands);
    if (label) {
      out.link_label = { arrow: r.guess ? "≈" : "→", text: label.text, nights: label.nights, inline: !contains(shown, label.text) };
    }
  } else if (cp && cpLabel) {
    const arrow = cp.direction === "out" ? "→" : cp.direction === "in" ? "←" : "⇄";
    out.link_label = { arrow, text: cpLabel, nights: null, inline: !contains(shown, cpLabel) };
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
