/**
 * Apple's App Store / iTunes mails, decoded into `merchant.purchase_document` payloads.
 *
 * Two families, both from no_reply@email.apple.com:
 * - receipts («Your receipt from Apple.» / «Your invoice from Apple.»): what one card charge
 *   bought — the items with their app, product and price, the total and the card;
 * - subscription notices («Your subscription confirmation», «… Renewal», «… is Expiring»,
 *   «… Price Increase»): an app's subscription price and its billing dates.
 *
 * The HTML is read as text lines (block tags break lines). Every template renders its content
 * twice (desktop, then mobile), so only the part before the first copyright footer is read.
 * Anything the decoder does not recognise throws: a template change must surface, never become
 * a guessed amount.
 */
import fs from "node:fs";
import path from "node:path";
import type { MerchantPurchaseDocument, MerchantPurchaseDocumentPayload, MerchantReceiptItem, SubscriptionPeriod } from "nw-tracker-contracts";
import { resolveCfraserDir } from "../paths.js";

export const APPLE_MERCHANT = "apple_app_store";
export const APPLE_MAIL_SENDER = "no_reply@email.apple.com";

/** A staged mail: what `fetch:apple-mail` writes. */
export type StagedAppleMail = { message_id: string; subject: string; date: string; html: string };

export function appleMailStagingDir(): string {
  return path.join(resolveCfraserDir(), "apple-mail");
}

export function listStagedAppleMailFiles(dir = appleMailStagingDir()): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => path.join(dir, f));
}

export type AppleMailKind = "receipt" | "subscription_notice";

/** Which family a subject belongs to; null for every other Apple mail (security alerts, news). */
export function appleMailKind(subject: string): AppleMailKind | null {
  const s = subject.trim();
  if (/^Your (receipt|invoice) from Apple\.?$/i.test(s)) return "receipt";
  if (/\bsubscriptions?\b/i.test(s)) return "subscription_notice";
  return null;
}

// ---------------------------------------------------------------------------------------------
// HTML → lines

const NAMED_ENTITIES: Record<string, string> = {
  nbsp: " ",
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  rsquo: "’",
  lsquo: "‘",
  rdquo: "”",
  ldquo: "“",
  ndash: "–",
  mdash: "—",
  hellip: "…",
  bull: "•",
  copy: "©",
  reg: "®",
  trade: "™",
  middot: "·",
  zwnj: "",
  zwj: "",
  eacute: "é",
  aacute: "á",
  iacute: "í",
  oacute: "ó",
  uacute: "ú",
  ntilde: "ñ",
  Eacute: "É",
  uuml: "ü",
  rsaquo: "›",
  lsaquo: "‹",
};

function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, body: string) => {
    if (body[0] === "#") {
      const code = body[1] === "x" || body[1] === "X" ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return NAMED_ENTITIES[body] ?? m;
  });
}

/** The mail's visible text, one line per block, blank lines dropped. */
export function htmlToLines(html: string): string[] {
  const text = html
    .replace(/<(style|script|head|title)\b[\s\S]*?<\/\1>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<br\s*\/?>|<\/(p|div|tr|td|th|li|h\d|table)>/gi, "\n")
    .replace(/<[^>]+>/g, " ");
  return decodeEntities(text)
    .split("\n")
    .map((l) => l.replace(/[\s ​‌‍͏﻿]+/g, " ").trim())
    .filter((l) => l.length > 0);
}

/** The first rendering: everything before the first copyright footer. */
function firstRendering(lines: string[]): string[] {
  const end = lines.findIndex((l) => /^(Copyright\b|TM and ©|All rights reserved Copyright)/.test(l));
  return end < 0 ? lines : lines.slice(0, end);
}

/** Artwork links in document order, each picture once. */
function iconUrls(html: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const m of html.matchAll(/<img\b[^>]*\bsrc="(https:\/\/is\d+-ssl\.mzstatic\.com\/image\/thumb\/[^"]+)"/gi)) {
    const url = decodeEntities(m[1]!);
    const key = url.slice(0, url.lastIndexOf("/"));
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(url);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Values

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

function isoDate(y: number, m: number, d: number): string {
  const date = new Date(Date.UTC(y, m - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) {
    throw new Error(`Not a calendar date: ${y}-${m}-${d}`);
  }
  return date.toISOString().slice(0, 10);
}

function monthNumber(name: string): number | null {
  return MONTHS[name.slice(0, 3).toLowerCase()] ?? null;
}

/**
 * «24 Jan 2016», «17 July 2026», «Sep 9, 2021», «September 9» — a date without its year takes the
 * mail's, moved a year on when that would put it more than a month before the mail.
 */
export function parseMailDate(text: string, mailedOn: string | null): string | null {
  const t = text.trim();
  let m = t.match(/^(\d{1,2}) ([A-Za-z]+)\.?(?: (\d{4}))?/);
  let day: number, month: number | null, year: number | null;
  if (m) {
    day = Number(m[1]);
    month = monthNumber(m[2]!);
    year = m[3] ? Number(m[3]) : null;
  } else {
    m = t.match(/^([A-Za-z]+)\.? (\d{1,2})(?:, (\d{4}))?/);
    if (!m) return null;
    month = monthNumber(m[1]!);
    day = Number(m[2]);
    year = m[3] ? Number(m[3]) : null;
  }
  if (month == null) return null;
  if (year != null) return isoDate(year, month, day);
  if (!mailedOn) throw new Error(`A date without its year and no mail date: ${JSON.stringify(text)}`);
  const mailYear = Number(mailedOn.slice(0, 4));
  let iso = isoDate(mailYear, month, day);
  if (Date.parse(iso) < Date.parse(mailedOn) - 31 * 86_400_000) iso = isoDate(mailYear + 1, month, day);
  return iso;
}

type Money = { amount: number; currency: "clp" | "usd" };

const PRICE_LINE = /^(USD\s*)?\$?\s?(\d[\d.,]*)$/;

/**
 * «$4,990» / «$8.900» / «$650» are pesos (the Chilean store prints no cents, with either
 * grouping mark); «USD 4.99» is dollars. A «$» amount with cents is no Chilean price and throws.
 */
export function parseMoney(text: string): Money | null {
  const m = text.trim().match(PRICE_LINE);
  if (!m) return null;
  const digits = m[2]!;
  if (m[1]) {
    if (!/^\d{1,3}(,\d{3})*(\.\d{2})?$/.test(digits)) throw new Error(`Unreadable dollar amount: ${JSON.stringify(text)}`);
    return { amount: Number(digits.replace(/,/g, "")), currency: "usd" };
  }
  if (!text.includes("$")) return null;
  if (!/^\d{1,3}([.,]\d{3})*$/.test(digits)) throw new Error(`Unreadable peso amount: ${JSON.stringify(text)}`);
  return { amount: Number(digits.replace(/[.,]/g, "")), currency: "clp" };
}

/** The billing period a plan line names: «(Monthly)», «(1 year)», «(3 months)», «/month», «Monthly | …». */
export function periodFromText(text: string): SubscriptionPeriod | null {
  const t = text.toLowerCase();
  if (/\((daily|1 day)\)/.test(t)) return "day";
  if (/\((weekly|1 week|7 days?)\)|\/week\b/.test(t)) return "week";
  if (/\((quarterly|3 months)\)|\/3 months\b/.test(t)) return "quarter";
  if (/\(6 months\)|\/6 months\b/.test(t)) return "half_year";
  if (/\((annual|yearly|1 year)\)|\/year\b|^yearly\b|\banual\b/.test(t)) return "year";
  if (/\((monthly|1 month)\)|\/month\b|^monthly\b/.test(t)) return "month";
  // A plan line that is only the length: «1 month», «1 year».
  const bare = t.match(/^(\d+) (day|week|month|year)s?$/);
  if (bare) return periodFromText(`(${bare[1]} ${bare[2]}${bare[1] === "1" ? "" : "s"})`);
  return null;
}

// ---------------------------------------------------------------------------------------------
// Receipts

/** Store-section headings a receipt groups its items under. */
const STORE_SECTIONS = new Set(["App Store", "Mac App Store", "iTunes Store", "Apple Books", "iBooks", "Books", "Apple Podcasts"]);
/** Service headings: the heading itself is the service when the item line only names a plan. */
const SERVICE_SECTIONS = new Set([
  "Apple TV",
  "Apple TV+",
  "iCloud",
  "Apple Music",
  "Apple One",
  "Apple Arcade",
  "Apple News+",
  "Apple Fitness+",
]);
/** Column headings and per-item links: never an item's own text. */
const NOISE = new Set(["TYPE", "PURCHASED FROM", "PRICE", "Report a Problem", "Write a Review", "In-App Purchase", "Subscription", "App", "Book", "Song", "Album", "Movie", "TV Episode"]);

function isNoise(line: string): boolean {
  return NOISE.has(line) || /^(Write a Review|Report a Problem)\b/.test(line);
}

/** «Cristian's iPhone SE», «Name's MacBook Pro» — the device an in-app purchase was made on. */
function isDeviceLine(line: string): boolean {
  return /['’]s (iPhone|iPad|iPod|Mac|MacBook|Apple Watch|Apple TV|Vision Pro)\b/.test(line);
}

function isRenewalLine(line: string): boolean {
  return /^Renews\b/.test(line) || /^(Monthly|Yearly|Weekly)\b/.test(line);
}

type ItemBlock = { section: string | null; lines: string[]; renewal: string[]; price: Money };

function itemFromBlock(block: ItemBlock, iconUrl: string | null): MerchantReceiptItem {
  const all = [...block.lines, ...block.renewal];
  const renews = block.renewal.length > 0 || all.some((l) => /Automatic Renewal|\((Monthly|Annual|Yearly|Quarterly|Weekly|Daily|\d+ (day|days|week|weeks|month|months|year))\)/i.test(l));
  let period: SubscriptionPeriod | null = null;
  for (const l of all) period ??= periodFromText(l);
  const [first, second] = block.lines;
  if (!first) throw new Error("A receipt item with a price but no name");
  let app: string | null;
  let product: string | null;
  if (block.section && SERVICE_SECTIONS.has(block.section) && /\((Monthly|Annual|Yearly|Quarterly|Weekly|Daily)\)$/.test(first)) {
    // «Apple One» / «Family (Monthly)»: the line is only the plan.
    app = block.section;
    product = first;
  } else if (second) {
    app = first;
    product = second;
  } else if (block.section == null || STORE_SECTIONS.has(block.section)) {
    // A store item with a single line names the product only when the store sells it in-app
    // («1 Boost»); a lone line in a service section or with no section is the app itself.
    app = renews || block.section == null ? first : null;
    product = app == null ? first : null;
  } else {
    app = first;
    product = null;
  }
  return { app, product, amount: block.price.amount, renews, period, icon_url: iconUrl };
}

function readItems(lines: string[]): { blocks: ItemBlock[]; currency: "clp" | "usd" } {
  const blocks: ItemBlock[] = [];
  let section: string | null = null;
  let pending: string[] = [];
  let renewal: string[] = [];
  let currency: "clp" | "usd" | null = null;
  for (const line of lines) {
    const price = parseMoney(line);
    if (price) {
      if (pending.length === 0) throw new Error(`A price with no item before it: ${JSON.stringify(line)}`);
      if (currency && price.currency !== currency) throw new Error("A receipt mixing currencies");
      currency = price.currency;
      blocks.push({ section, lines: pending, renewal, price });
      pending = [];
      renewal = [];
    } else if (STORE_SECTIONS.has(line) || SERVICE_SECTIONS.has(line)) {
      if (pending.length > 0) throw new Error(`Item lines with no price before ${JSON.stringify(line)}: ${JSON.stringify(pending)}`);
      section = line;
    } else if (isRenewalLine(line)) {
      renewal.push(line);
    } else if (!isNoise(line) && !isDeviceLine(line)) {
      pending.push(line);
    }
  }
  if (pending.length > 0) throw new Error(`Item lines with no price: ${JSON.stringify(pending)}`);
  if (!currency) throw new Error("A receipt with no priced item");
  return { blocks, currency };
}

function after(lines: string[], label: string): string | null {
  const i = lines.indexOf(label);
  return i >= 0 && i + 1 < lines.length ? lines[i + 1]! : null;
}

const CARD_LINE = /(?:\.{2,}|•{2,})\s*(\d{4})$/;

export function decodeAppleReceipt(html: string): Extract<MerchantPurchaseDocument, { type: "receipt" }> {
  const lines = firstRendering(htmlToLines(html));
  let issuedText: string | null;
  let cardLast4: string | null = null;
  let orderId: string | null;
  let itemLines: string[];
  let total: Money | null = null;

  if (lines.includes("Document:")) {
    // 2025 layout: «Invoice / 4 July 2025 / Order ID: / … / Apple Account: / <address>», items,
    // then «Billing and Payment», the address, the subtotal and VAT, the card and the total.
    issuedText = lines[1] ?? null;
    orderId = after(lines, "Order ID:");
    const start = lines.indexOf("Apple Account:") + 2;
    const stop = lines.indexOf("Billing and Payment");
    if (start < 2 || stop < start) throw new Error("Receipt layout not recognised (no account / billing block)");
    itemLines = lines.slice(start, stop);
    const cardAt = lines.findIndex((l, i) => i > stop && CARD_LINE.test(l));
    if (cardAt < 0) throw new Error("Receipt without the card it charged");
    cardLast4 = lines[cardAt]!.match(CARD_LINE)![1]!;
    total = parseMoney(lines[cardAt + 1] ?? "");
  } else {
    issuedText = after(lines, "INVOICE DATE") ?? after(lines, "DATE");
    orderId = after(lines, "ORDER ID");
    const billed = after(lines, "BILLED TO");
    const card = billed?.match(CARD_LINE);
    cardLast4 = card ? card[1]! : null;
    const start = lines.indexOf("DOCUMENT NO.") + 2;
    if (start < 2) throw new Error("Receipt layout not recognised (no DOCUMENT NO.)");
    let stop = lines.findIndex((l, i) => i >= start && (l === "Subtotal" || l === "TOTAL"));
    if (stop < 0) stop = lines.length;
    itemLines = lines.slice(start, stop);
    for (let i = stop; i < lines.length - 1; i++) {
      if (lines[i] === "TOTAL") {
        total = parseMoney(lines[i + 1]!);
        if (total) break;
      }
    }
  }
  if (!issuedText) throw new Error("Receipt without its date");
  const issuedOn = parseMailDate(issuedText, null);
  if (!issuedOn) throw new Error(`Unreadable receipt date: ${JSON.stringify(issuedText)}`);
  if (!total) throw new Error("Receipt without its total");

  const { blocks, currency } = readItems(itemLines);
  if (currency !== total.currency) throw new Error("Receipt items and total in different currencies");
  const icons = iconUrls(html);
  const items = blocks.map((b, i) => itemFromBlock(b, icons.length === blocks.length ? icons[i]! : null));
  const sum = items.reduce((s, i) => s + i.amount, 0);
  if (Math.abs(sum - total.amount) > (total.currency === "clp" ? 0.5 : 0.005)) {
    throw new Error(`Receipt items add up to ${sum}, the total says ${total.amount}`);
  }
  return { type: "receipt", issued_on: issuedOn, order_id: orderId, card_last4: cardLast4, total, items };
}

// ---------------------------------------------------------------------------------------------
// Subscription notices

type Notice = Extract<MerchantPurchaseDocument, { type: "subscription_notice" }>;

function noticeKind(subject: string, heading: string): Notice["notice"] {
  const s = `${subject} ${heading}`.toLowerCase();
  if (s.includes("price increase")) return "price_increase";
  if (s.includes("expiring") || s.includes("expire")) return "expiring";
  if (s.includes("renewal")) return "renewal";
  if (s.includes("confirm")) return "confirmed";
  throw new Error(`Unknown subscription notice: ${JSON.stringify(subject)}`);
}

const DATE_TEXT = String.raw`(\d{1,2} [A-Z][a-z]+(?: \d{4})?|[A-Z][a-z]+ \d{1,2}(?:, \d{4})?)`;

function firstDate(body: string, pattern: string, mailedOn: string): string | null {
  const m = body.match(new RegExp(pattern.replace("<DATE>", DATE_TEXT)));
  return m ? parseMailDate(m[1]!, mailedOn) : null;
}

function addDays(iso: string, days: number): string {
  return new Date(Date.parse(iso) + days * 86_400_000).toISOString().slice(0, 10);
}

/** «Grindr LLC - XTRA (3 months) - $16.500/3 months starting 25 January 2021» (one line per plan). */
const RENEWALS_LINE = new RegExp(String.raw`^(.+?) - (.+?) - (\$[\d.,]+)\s*/\s*([\w ]+?) starting ` + DATE_TEXT + "$");

export function decodeAppleSubscriptionNotice(html: string, subject: string, mailedOn: string): Notice[] {
  const lines = firstRendering(htmlToLines(html));
  const body = lines.join("\n");
  const heading = lines[0] ?? "";
  const notice = noticeKind(subject, heading);
  const card = body.match(/Payment Method\n(?:Visa|MasterCard|Amex|American Express)[^\n]*?(\d{4})\n/);
  const cardLast4 = card ? card[1]! : null;

  // A digest of several renewals: one plan per line.
  const digest = lines.map((l) => l.match(RENEWALS_LINE)).filter((m): m is RegExpMatchArray => m != null);
  if (digest.length > 0) {
    return digest.map((m) => {
      const price = parseMoney(m[3]!);
      const period = periodFromText(`/${m[4]}`);
      if (!price || !period) throw new Error(`Unreadable renewal line: ${JSON.stringify(m[0])}`);
      return {
        type: "subscription_notice",
        notice,
        mailed_on: mailedOn,
        app: m[1]!.trim(),
        plan: m[2]!.trim(),
        price,
        period,
        purchased_on: null,
        next_charge_on: parseMailDate(m[5]!, mailedOn),
        expires_on: null,
        card_last4: cardLast4,
      };
    });
  }

  // The app: the «App» field when printed, else the line under the heading. A service's own
  // template («Your Apple TV+ Subscription Renewal») names the service in the subject.
  let app = after(lines, "App") ?? lines[1] ?? null;
  const serviceSubject = subject.match(/^Your (.+?) Subscription Renewal$/i);
  if (serviceSubject && !/^subscription$/i.test(serviceSubject[1]!)) app = serviceSubject[1]!;
  if (!app || /^Dear\b/.test(app)) throw new Error(`Subscription notice without its app: ${JSON.stringify(subject)}`);
  const plan = after(lines, "Subscription") ?? (lines[2] && !/^Dear\b/.test(lines[2]) ? lines[2] : null);

  let price: Money | null = null;
  const newPrice = body.match(/New (\$[\d.,]+)/);
  if (newPrice) price = parseMoney(newPrice[1]!);
  for (const re of [/(?:Renewal Price|Subscription Price|Price)\n(\$[\d.,]+)/, /(\$[\d.,]+)\s*\/\s*(?:month|year|week|\d+ months)/, /(\$[\d.,]+)/]) {
    if (price) break;
    const m = body.match(re);
    if (m) price = parseMoney(m[1]!);
  }
  if (!price) throw new Error(`Subscription notice without a price: ${JSON.stringify(subject)}`);

  const priceUnit = body.match(/\$[\d.,]+\s*(\/\s*(?:month|year|week|3 months|6 months))/);
  let period = priceUnit ? periodFromText(priceUnit[1]!.replace(/\s/g, "")) : null;
  for (const l of lines.slice(1, 5)) period ??= periodFromText(l);
  if (!period) throw new Error(`Subscription notice without a period: ${JSON.stringify(subject)}`);

  // A free trial charges nothing on the day it is taken: the first charge is the price's start.
  const trial = /free trial|\bTrial\b/.test(body);
  const purchasedOn = trial ? null : firstDate(body, String.raw`Date of Purchase\n<DATE>`, mailedOn);
  const cancelBy = firstDate(body, String.raw`cancel by <DATE>`, mailedOn);
  const nextCharge =
    firstDate(body, String.raw`\$[\d.,]+\s*/\s*[\w ]+?, starting <DATE>`, mailedOn) ??
    firstDate(body, String.raw`[Ss]tarting (?:from |on )?<DATE>`, mailedOn) ??
    firstDate(body, String.raw`renews? (?:on )?<DATE>`, mailedOn) ??
    (cancelBy ? addDays(cancelBy, 1) : null);
  const expiresOn =
    notice === "expiring"
      ? firstDate(body, String.raw`expires? on <DATE>`, mailedOn) ?? firstDate(body, String.raw` – <DATE>`, mailedOn)
      : null;

  return [
    {
      type: "subscription_notice",
      notice,
      mailed_on: mailedOn,
      app,
      plan,
      price,
      period,
      purchased_on: purchasedOn,
      next_charge_on: nextCharge,
      expires_on: expiresOn,
      card_last4: cardLast4,
    },
  ];
}

// ---------------------------------------------------------------------------------------------

/** The Chile calendar day a mail was sent. */
export function chileDay(dateIso: string): string {
  return new Date(dateIso).toLocaleDateString("en-CA", { timeZone: "America/Santiago" });
}

export function appleMailPayload(mail: StagedAppleMail): MerchantPurchaseDocumentPayload {
  const kind = appleMailKind(mail.subject);
  if (kind == null) throw new Error(`Not a receipt or subscription mail: ${JSON.stringify(mail.subject)}`);
  const documents: MerchantPurchaseDocument[] =
    kind === "receipt"
      ? [decodeAppleReceipt(mail.html)]
      : decodeAppleSubscriptionNotice(mail.html, mail.subject, chileDay(mail.date));
  return { merchant: APPLE_MERCHANT, documents };
}
