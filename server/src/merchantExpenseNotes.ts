/**
 * App Store charges are named by the app they paid for.
 *
 * A card statement names every App Store charge the same way («APPLE.COM/BILL»); Apple's own
 * mails say what each one bought. `merchant.purchase_document` stores them (receipts with their
 * items, subscription notices with their price and billing dates — migration 204), and this
 * module derives, every time the expense lines are built, which app each charge paid for: a link
 * the expenses page shows under the charge like a payment processor's receipt
 * (`paymentProcessorReceipts.ts`). Nothing is written; the expense notes are the user's own.
 *
 * Three kinds of evidence, strongest first:
 * 1. **Receipt.** A receipt pairs 1:1 with the charge on the card it names (its account), for
 *    the same amount — the peso origin to the peso, or the dollars at that day's rate within 4%
 *    when the line carries only dollars (the open month's feed rows) — dated one day before to
 *    five days after the receipt; an exact amount first, then the nearest date (a charge on or
 *    after the receipt before one the day before). The note is the
 *    receipt's apps. An item that names only its product («1 Boost») takes the app from another
 *    receipt showing the same artwork, or from a subscription notice whose plan it is; when
 *    neither names it the receipt is reported and its charge left alone.
 * 2. **Subscription cadence.** Renewals usually come with no receipt. A charge of a
 *    subscription's price (to the peso, or within 3% by the day's rate) on its billing cycle (an
 *    anchor date ± whole periods, within 3 days; a week within a day), on the same card, within
 *    500 days of an anchor: a subscription receipt's charge, or a notice's purchase / next charge
 *    / expiry date.
 * 3. **Monthly run.** A charge one month (26–35 days, day of month ± 3) after a noted charge of
 *    the same amount on the same card takes that note — unless that charge's receipt was a
 *    one-off purchase (a boost bought again a month later is no renewal).
 * Kinds 2 and 3 are inferences and the link says so (`guess`); several candidate apps name the
 * nearest. They wait until the receipt window has passed (a charge more than five days old), so a
 * receipt that arrives after its charge claims it first.
 *
 * Labels: an app keeps the note its receipt-paired charges already carry («iCloud+» → «icloud»,
 * the majority among plain notes); else its printed name cut at the first « - », «: », «, » or
 * « (» and lowercased («Grindr - Gay Dating & Chat» → «grindr»), shortened to an App Store note
 * that name starts with («Tinder Dating App» → «tinder»).
 */
import { resolveCcExpensePurchaseKey } from "./ccExpenseCategories.js";
import { resolveMasterAccountIdForImportCardLast4 } from "./ccConsolidatedCards.js";
import { statementLineDateIso } from "./ccInstallmentPayBy.js";
import { chileWallClockAt } from "./chileDate.js";
import { db } from "./db.js";
import { fxRowOnOrBefore } from "./fxRates.js";

export const APP_STORE_MERCHANT = "apple_app_store";

/** How the card statement names App Store billing (the Apple Store's hardware sales are «APPLE.COM CL»). */
const APP_STORE_CARD_MERCHANT = /^(APPLE\.COM[/ ]BILL|ITUNES\.COM\/BILL)\b/i;

const GUESS_PREFIX = "guess: ";
const RECEIPT_DAYS_BEFORE = 1;
const RECEIPT_DAYS_AFTER = 5;
const RECEIPT_FX_TOLERANCE = 0.04;
const CADENCE_FX_TOLERANCE = 0.03;
const CADENCE_DAYS = 3;
const CADENCE_WINDOW_DAYS = 500;

type Period = "day" | "week" | "month" | "quarter" | "half_year" | "year";
const PERIOD_MONTHS: Partial<Record<Period, number>> = { month: 1, quarter: 3, half_year: 6, year: 12 };

type Charge = {
  accountId: number;
  key: string;
  date: string;
  pesos: number | null;
  usd: number | null;
  /** Pesos, or the dollars at the day's rate; null when neither can be had. */
  clp: number | null;
  note: string | null;
  link: MerchantChargeLink | null;
};

type ReceiptItem = { app: string | null; product: string | null; amount: number; renews: boolean; period: Period | null; iconKey: string | null };
type Receipt = {
  id: number;
  sourceRef: string;
  issuedOn: string;
  accountId: number | null;
  total: number;
  currency: "clp" | "usd";
  items: ReceiptItem[];
};
type Notice = {
  app: string;
  plan: string | null;
  price: number;
  currency: "clp" | "usd";
  period: Period;
  notice: "confirmed" | "renewal" | "expiring" | "price_increase";
  anchors: string[];
  accountId: number | null;
  validFrom: string | null;
  validBefore: string | null;
};

/** Which app a charge paid for, as the documents show it. */
export type MerchantChargeLink = {
  account_id: number;
  key: string;
  date: string;
  /** Short, lowercase, as an expense note would name it («grindr»). */
  label: string;
  /** The app's printed name(s) («Grindr - Gay Dating & Chat»). */
  name: string;
  /** What the receipt's items bought («Boost»), when it says. */
  concept: string | null;
  basis: string;
  /** Inferred from a subscription's cycle or a monthly run, not from a receipt. */
  guess: boolean;
  /**
   * The charge is a subscription's: every item of its receipt renews, or it was inferred from a
   * subscription's cycle or a monthly run of the same charge.
   */
  subscription: boolean;
};

export type MerchantChargeLinksResult = {
  links: MerchantChargeLink[];
  /** Each receipt's charge, by the receipt's source ref; absent = still waiting for one. */
  receipt_charges: Map<string, { account_id: number; date: string }[]>;
  /** Receipts paired with a charge whose app no document names. */
  unresolved: { source_ref: string; issued_on: string; products: string[] }[];
};

// ---------------------------------------------------------------------------------------------

function days(a: string, b: string): number {
  return Math.round((Date.parse(b) - Date.parse(a)) / 86_400_000);
}

function addMonths(iso: string, n: number): string {
  const [y, m, d] = iso.split("-").map(Number) as [number, number, number];
  const total = m - 1 + n;
  const year = y + Math.floor(total / 12);
  const month = ((total % 12) + 12) % 12;
  const last = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return new Date(Date.UTC(year, month, Math.min(d, last))).toISOString().slice(0, 10);
}

/** Whether `date` falls on the billing cycle `anchor` sets: anchor ± whole periods. */
export function onBillingCycle(date: string, anchor: string, period: Period): boolean {
  const gap = days(anchor, date);
  if (period === "day") return true;
  if (period === "week") {
    const r = ((gap % 7) + 7) % 7;
    return Math.min(r, 7 - r) <= 1;
  }
  const step = PERIOD_MONTHS[period]!;
  const [ay, am] = anchor.split("-").map(Number) as [number, number];
  const [dy, dm] = date.split("-").map(Number) as [number, number];
  const k0 = Math.floor(((dy - ay) * 12 + (dm - am)) / step);
  return [k0 - 1, k0, k0 + 1].some((k) => Math.abs(days(addMonths(anchor, k * step), date)) <= CADENCE_DAYS);
}

/** «Grindr - Gay Dating & Chat» → «grindr»: the name before its tagline, lowercased. */
export function shortAppLabel(app: string): string {
  return app.split(/ - | – |: |, | \(/)[0]!.trim().toLowerCase();
}

function iconKey(url: string | null): string | null {
  return url ? url.slice(0, url.lastIndexOf("/")) : null;
}

function normalizedPlan(text: string): string {
  return text
    .replace(/\((Automatic Renewal|Monthly|Annual|Yearly|Quarterly|Weekly|\d+ \w+)\)/gi, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function amountsAgree(charge: Charge, price: number, currency: "clp" | "usd", tolerance: number): number | null {
  if (currency === "usd") return charge.usd != null && Math.abs(charge.usd - price) < 0.005 ? 0 : null;
  if (charge.pesos != null) return charge.pesos === Math.round(price) ? 0 : null;
  if (charge.clp == null) return null;
  const err = Math.abs(charge.clp - price) / price;
  return err <= tolerance ? err : null;
}

// ---------------------------------------------------------------------------------------------
// Loading

function loadCharges(): Charge[] {
  const rows = db
    .prepare(
      `SELECT l.id, s.account_id, l.transaction_date, l.posting_date, l.merchant,
              l.amount_clp, l.amount_usd, l.amount_orig, l.orig_currency
       FROM cc_statement_lines l
       JOIN cc_statements s ON s.id = l.statement_id
       WHERE l.installment_flag = 0
         AND (upper(l.merchant) LIKE 'APPLE.COM%' OR upper(l.merchant) LIKE 'ITUNES.COM%')
       ORDER BY l.id`
    )
    .all() as {
    id: number;
    account_id: number;
    transaction_date: string | null;
    posting_date: string | null;
    merchant: string;
    amount_clp: number | null;
    amount_usd: number | null;
    amount_orig: number | null;
    orig_currency: string | null;
  }[];
  const notes = new Map(
    (db.prepare(`SELECT account_id, purchase_key, notes FROM cc_expense_purchase_notes`).all() as {
      account_id: number;
      purchase_key: string;
      notes: string;
    }[]).map((r) => [`${r.account_id}|${r.purchase_key}`, r.notes])
  );
  const byKey = new Map<string, Charge>();
  for (const r of rows) {
    if (!APP_STORE_CARD_MERCHANT.test(r.merchant.trim())) continue;
    const date = statementLineDateIso(r);
    if (!date) throw new Error(`App Store card line ${r.id} has no date`);
    const pesos =
      r.orig_currency === "clp" && r.amount_orig != null && r.amount_orig > 0
        ? Math.round(r.amount_orig)
        : r.amount_clp != null && r.amount_clp > 0
          ? r.amount_clp
          : null;
    const usd = r.amount_usd != null && r.amount_usd > 0 ? r.amount_usd : null;
    if (pesos == null && usd == null) continue; // a refund or a payment, not a purchase
    const key = resolveCcExpensePurchaseKey(r.id);
    const mapKey = `${r.account_id}|${key}`;
    const seen = byKey.get(mapKey);
    if (seen) {
      // Another copy of the same purchase (a re-downloaded statement): it may carry the pesos.
      seen.pesos ??= pesos;
      seen.usd ??= usd;
      continue;
    }
    byKey.set(mapKey, { accountId: r.account_id, key, date, pesos, usd, clp: null, note: notes.get(mapKey) ?? null, link: null });
  }
  const charges = [...byKey.values()];
  for (const c of charges) {
    c.clp = c.pesos ?? (c.usd != null ? estimateClp(c.usd, c.date) : null);
  }
  return charges.sort((a, b) => a.date.localeCompare(b.date) || a.accountId - b.accountId || a.key.localeCompare(b.key));
}

function estimateClp(usd: number, date: string): number | null {
  const fx = fxRowOnOrBefore(date);
  return fx ? usd * fx.clp_per_usd : null;
}

function accountForCard(last4: string | null): number | null {
  return last4 ? resolveMasterAccountIdForImportCardLast4(last4) : null;
}

function loadReceipts(merchant: string): Receipt[] {
  const receipts = db
    .prepare(
      `SELECT r.id, s.source_ref, r.issued_on, r.card_last4, r.total_amount, r.currency
       FROM merchant_receipts r JOIN merchant_document_sources s ON s.id = r.source_id
       WHERE r.merchant = ? ORDER BY r.issued_on, r.id`
    )
    .all(merchant) as { id: number; source_ref: string; issued_on: string; card_last4: string | null; total_amount: number; currency: "clp" | "usd" }[];
  const items = db
    .prepare(
      `SELECT i.receipt_id, i.app, i.product, i.amount, i.renews, i.period, i.icon_url
       FROM merchant_receipt_items i JOIN merchant_receipts r ON r.id = i.receipt_id
       WHERE r.merchant = ? ORDER BY i.receipt_id, i.position`
    )
    .all(merchant) as { receipt_id: number; app: string | null; product: string | null; amount: number; renews: number; period: Period | null; icon_url: string | null }[];
  const byReceipt = new Map<number, ReceiptItem[]>();
  for (const i of items) {
    const list = byReceipt.get(i.receipt_id) ?? [];
    list.push({ app: i.app, product: i.product, amount: i.amount, renews: i.renews === 1, period: i.period, iconKey: iconKey(i.icon_url) });
    byReceipt.set(i.receipt_id, list);
  }
  return receipts.map((r) => ({
    id: r.id,
    sourceRef: r.source_ref,
    issuedOn: r.issued_on,
    accountId: accountForCard(r.card_last4),
    total: r.total_amount,
    currency: r.currency,
    items: byReceipt.get(r.id) ?? [],
  }));
}

function loadNotices(merchant: string): Notice[] {
  const rows = db
    .prepare(
      `SELECT notice, app, plan, price, currency, period, purchased_on, next_charge_on, expires_on, card_last4
       FROM merchant_subscription_notices WHERE merchant = ? ORDER BY mailed_on, id`
    )
    .all(merchant) as {
    notice: Notice["notice"];
    app: string;
    plan: string | null;
    price: number;
    currency: "clp" | "usd";
    period: Period;
    purchased_on: string | null;
    next_charge_on: string | null;
    expires_on: string | null;
    card_last4: string | null;
  }[];
  return rows.map((r) => ({
    app: r.app,
    plan: r.plan,
    price: r.price,
    currency: r.currency,
    period: r.period,
    notice: r.notice,
    anchors: [r.purchased_on, r.next_charge_on, r.expires_on].filter((d): d is string => d != null),
    accountId: accountForCard(r.card_last4),
    // A new price applies from its first charge; an expiring plan charges nothing from its end.
    validFrom: r.notice === "price_increase" ? r.next_charge_on : null,
    validBefore: r.notice === "expiring" ? r.expires_on : null,
  }));
}

// ---------------------------------------------------------------------------------------------

/** Names every App Store charge some document explains (see the module comment). */
export function deriveMerchantChargeLinks(opts?: {
  merchant?: string;
  /** Chile today by default; charges within the receipt window of it get receipt links only. */
  today?: string;
}): MerchantChargeLinksResult {
  const merchant = opts?.merchant ?? APP_STORE_MERCHANT;
  const today = opts?.today ?? chileWallClockAt(new Date()).ymd;
  const result: MerchantChargeLinksResult = { links: [], receipt_charges: new Map(), unresolved: [] };
  const hasDocuments = db.prepare(`SELECT 1 FROM merchant_document_sources WHERE merchant = ? LIMIT 1`).get(merchant);
  if (!hasDocuments) return result;

  const charges = loadCharges();
  const receipts = loadReceipts(merchant);
  const notices = loadNotices(merchant);

  // 1. Receipt ↔ charge, 1:1.
  // Exact amounts first; then the charge nearest the receipt (on or after it before the day
  // before); the rate-estimated gap only breaks ties — two dollar-only charges of one price sit
  // within a percent of each other, and the nearer date is the better evidence.
  const candidates: { approx: number; order: number; err: number; ri: number; ci: number }[] = [];
  receipts.forEach((r, ri) => {
    charges.forEach((c, ci) => {
      if (r.accountId != null && c.accountId !== r.accountId) return;
      const dd = days(r.issuedOn, c.date);
      if (dd < -RECEIPT_DAYS_BEFORE || dd > RECEIPT_DAYS_AFTER) return;
      const err = amountsAgree(c, r.total, r.currency, RECEIPT_FX_TOLERANCE);
      if (err == null) return;
      candidates.push({ approx: c.pesos != null || r.currency === "usd" ? 0 : 1, order: dd >= 0 ? dd : 10 - dd, err, ri, ci });
    });
  });
  candidates.sort((a, b) => a.approx - b.approx || a.order - b.order || a.err - b.err || a.ri - b.ri || a.ci - b.ci);
  const chargeOfReceipt = new Map<number, number>();
  const receiptOfCharge = new Map<number, number>();
  for (const c of candidates) {
    if (chargeOfReceipt.has(c.ri) || receiptOfCharge.has(c.ci)) continue;
    chargeOfReceipt.set(c.ri, c.ci);
    receiptOfCharge.set(c.ci, c.ri);
  }

  // App names for items that print only their product.
  const appByIcon = new Map<string, string>();
  for (const r of receipts) for (const i of r.items) if (i.app && i.iconKey) appByIcon.set(i.iconKey, i.app);
  const appByPlan = new Map<string, string>();
  for (const n of notices) if (n.plan) appByPlan.set(normalizedPlan(n.plan), n.app);
  const itemApp = (i: ReceiptItem): string | null =>
    i.app ?? (i.iconKey ? appByIcon.get(i.iconKey) : undefined) ?? (i.product ? appByPlan.get(normalizedPlan(i.product)) : undefined) ?? null;

  // Labels: the note an app's receipt-paired charges already carry, else its short name.
  const votes = new Map<string, Map<string, number>>();
  for (const [ri, ci] of chargeOfReceipt) {
    const apps = [...new Set(receipts[ri]!.items.map(itemApp))];
    const note = charges[ci]!.note;
    if (apps.length !== 1 || apps[0] == null || !note || note.startsWith(GUESS_PREFIX) || note.includes(" + ")) continue;
    const k = shortAppLabel(apps[0]);
    const v = votes.get(k) ?? new Map<string, number>();
    v.set(note, (v.get(note) ?? 0) + 1);
    votes.set(k, v);
  }
  // An app new to the receipts may still have a name its earlier charges were noted under:
  // «tinder dating app» → «tinder», «halide mark ii» → «halide» (the longest plain App Store
  // note its short name starts with, followed by a word break).
  const plainNotes = [...new Set(charges.map((c) => c.note).filter((n): n is string => !!n && !n.startsWith(GUESS_PREFIX) && !n.includes(" + ")))];
  const label = (app: string): string => {
    const short = shortAppLabel(app);
    const v = votes.get(short);
    if (v) return [...v.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]![0];
    const prefix = plainNotes
      .filter((n) => short === n || (short.startsWith(n) && /^[^a-z0-9]/.test(short.slice(n.length))))
      .sort((a, b) => b.length - a.length)[0];
    return prefix ?? short;
  };

  const link = (c: Charge, apps: string[], labels: string[], concept: string | null, basis: string, guess: boolean, subscription: boolean): void => {
    c.link = {
      account_id: c.accountId,
      key: c.key,
      date: c.date,
      label: labels.join(" + "),
      name: apps.join(" + "),
      concept,
      basis,
      guess,
      subscription,
    };
    result.links.push(c.link);
  };

  // 2. Receipt-paired charges.
  for (const [ri, ci] of chargeOfReceipt) {
    const r = receipts[ri]!;
    const c = charges[ci]!;
    const list = result.receipt_charges.get(r.sourceRef) ?? [];
    list.push({ account_id: c.accountId, date: c.date });
    result.receipt_charges.set(r.sourceRef, list);
    const apps = r.items.map(itemApp);
    if (apps.some((a) => a == null)) {
      result.unresolved.push({
        source_ref: r.sourceRef,
        issued_on: r.issuedOn,
        products: r.items.filter((_, i) => apps[i] == null).map((i) => i.product ?? "?"),
      });
      continue;
    }
    const named = [...new Set(apps as string[])];
    const products = [...new Set(r.items.map((i) => i.product).filter((x): x is string => !!x))];
    link(c, named, [...new Set(named.map(label))], products.length > 0 ? products.join(" + ") : null, `receipt ${r.issuedOn}`, false, r.items.every((i) => i.renews));
  }

  // 3. Cadence evidence: subscription receipts' charges and notices.
  type Evidence = { app: string; label: string; accountId: number | null; price: number; currency: "clp" | "usd"; period: Period; anchor: string; validFrom: string | null; validBefore: string | null; basis: string };
  const evidence: Evidence[] = [];
  for (const [ri, ci] of chargeOfReceipt) {
    const r = receipts[ri]!;
    if (r.items.length !== 1) continue;
    const item = r.items[0]!;
    const app = itemApp(item);
    if (!item.renews || app == null) continue;
    evidence.push({
      app,
      label: label(app),
      accountId: charges[ci]!.accountId,
      price: item.amount,
      currency: r.currency,
      period: item.period ?? "month",
      anchor: charges[ci]!.date,
      validFrom: null,
      validBefore: null,
      basis: "subscription receipt",
    });
  }
  for (const n of notices) {
    for (const anchor of n.anchors) {
      evidence.push({ app: n.app, label: label(n.app), accountId: n.accountId, price: n.price, currency: n.currency, period: n.period, anchor, validFrom: n.validFrom, validBefore: n.validBefore, basis: `subscription ${n.notice} notice` });
    }
  }

  // A charge paired with a one-off purchase is no month of a subscription.
  const oneOff = new Set<number>();
  for (const [ri, ci] of chargeOfReceipt) if (receipts[ri]!.items.every((i) => !i.renews)) oneOff.add(ci);

  charges.forEach((c, ci) => {
    if (receiptOfCharge.has(ci) || c.clp == null) return;
    if (days(c.date, today) <= RECEIPT_DAYS_AFTER) return;
    const found = new Map<string, { app: string; distance: number; basis: string }>();
    const offer = (lbl: string, app: string, distance: number, basis: string): void => {
      const seen = found.get(lbl);
      if (!seen || distance < seen.distance) found.set(lbl, { app, distance, basis });
    };
    for (const e of evidence) {
      if (e.accountId != null && e.accountId !== c.accountId) continue;
      if (e.validFrom && days(e.validFrom, c.date) < -CADENCE_DAYS) continue;
      if (e.validBefore && c.date >= e.validBefore) continue;
      const distance = Math.abs(days(e.anchor, c.date));
      if (distance > CADENCE_WINDOW_DAYS) continue;
      if (amountsAgree(c, e.price, e.currency, CADENCE_FX_TOLERANCE) == null) continue;
      if (!onBillingCycle(c.date, e.anchor, e.period)) continue;
      offer(e.label, e.app, distance, e.basis);
    }
    // 4. The same charge a month earlier, already noted.
    for (let pi = ci - 1; pi >= 0; pi--) {
      const p = charges[pi]!;
      const gap = days(p.date, c.date);
      if (gap > 35) break;
      // The earlier charge's name: its link, else a note the user wrote.
      const prevLabel = p.link?.label ?? (p.note && !p.note.startsWith(GUESS_PREFIX) ? p.note : null);
      if (gap < 26 || p.accountId !== c.accountId || !prevLabel || p.clp == null || oneOff.has(pi)) continue;
      const dom = Math.abs(Number(p.date.slice(8)) - Number(c.date.slice(8)));
      if (Math.min(dom, 31 - dom) > CADENCE_DAYS) continue;
      const same =
        p.pesos != null && c.pesos != null ? p.pesos === c.pesos : Math.abs(p.clp - c.clp) / p.clp <= CADENCE_FX_TOLERANCE;
      if (!same) continue;
      offer(prevLabel, p.link?.name ?? prevLabel, gap, "monthly run");
    }
    if (found.size === 0) return;
    const ranked = [...found.entries()].sort((a, b) => a[1].distance - b[1].distance || a[0].localeCompare(b[0]));
    const [best, how] = ranked[0]!;
    link(c, [how.app], [best], null, found.size > 1 ? `ambiguous: ${ranked.map((r) => r[0]).join(" / ")}` : how.basis, true, true);
  });
  return result;
}
