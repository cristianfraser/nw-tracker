/**
 * Lodging mails → canonical `payment.processor_receipts` receipts: each card charge for a stay
 * («Hotel at Booking.com», «AIRBNB * HM…», «<HOTEL NAME>», «<PROPERTY MANAGER> BOOKING») linked to
 * the property and the dates it paid for.
 *
 * - **Booking.com** (`booking`): the «Thanks! Your booking is confirmed at <property>» mail, and
 *   «Your updated booking at <property>» after a change. Who charges depends on the booking:
 *   Booking itself («You've paid € 112.50 for this booking», or a payment it schedules — «Jun 27,
 *   2025 •••• 1234 Scheduled £423»), or the property, at any time before the stay («Your payment
 *   will be handled by …», a prepayment) or at the stay («You'll pay when you stay at …»). The
 *   amount is what Booking charged or scheduled, else the price the mail states; a property may
 *   charge something else (a card surcharge, its own fees, in local currency) and when it does not
 *   say when, `paid_at_chile` is the mail's own time and the stay's dates are in `concept`. An
 *   updated booking states every payment taken so far: two or more become `charges`, and it
 *   supersedes the earlier mails of the same booking (same `order_ref`).
 * - **Airbnb** (`airbnb`): «Reservation confirmed for <city>», which names the listing and lists
 *   the payments (a card row, and Airbnb credit or coupons, which the card was not charged for).
 *   The «Your receipt from Airbnb» mail repeats the payments without the listing's name and is not
 *   read. The card is charged once, at booking; the statement names the reservation code
 *   («AIRBNB * HM…»), which is the `order_ref`.
 * - **Stripe receipts** (`stripe`): «Your <merchant> receipt [#…]», which a property that takes
 *   its own payment (Booking hands the payment to it) mails through Stripe — e.g. a property manager
 *   charging a Booking stay at the full price plus cleaning, a different amount from Booking's.
 * - **Accor** (`accor`): ALL.com's «Confirmation of your reservation: <hotel> No.<ref>», with what
 *   was paid at booking («Amount already paid: EUR 525.79») and what is left for the hotel.
 *
 * A mail that is not a booking's confirmation or a payment (messages, reminders, reviews, flights,
 * car rentals, marketing) decodes to null; a confirmation this decoder cannot read throws.
 */
import type { ProcessorReceipt } from "nw-tracker-contracts";
import type { ArchivedMail } from "../email/santanderMailArchive.js";
import type { PaymentProcessor } from "./paymentReceiptMails.js";

function fail(mail: ArchivedMail, why: string): never {
  throw new Error(`${mail.sent_at_chile} «${mail.subject}» (${mail.message_id}): ${why}`);
}

/**
 * The text as one line: HTML entities decoded, UTF-8 read as Latin-1 repaired («â€¢» → «•»), «Â »
 * and zero-width joiners (Airbnb spaces its dates with them) dropped.
 */
function flatten(text: string): string {
  return text
    .replace(/&#x([0-9a-f]+);/gi, (_, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&amp;/g, "&")
    .replace(/[Â-ô][\u0080-¿]{1,3}/g, (run) => {
      const fixed = Buffer.from(run, "latin1").toString("utf8");
      return fixed.includes("�") ? run : fixed;
    })
    .replace(/Â(?=\s|$)/g, "")
    .replace(/[​-‍⁠﻿]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

// ─── Money ───────────────────────────────────────────────────────────────────

/** Currency tokens as the lodging mails print them; a token missing here is not read. */
const TOKENS: Record<string, string> = {
  "€": "eur",
  EUR: "eur",
  "£": "gbp",
  GBP: "gbp",
  "US$": "usd",
  USD: "usd",
  "NZ$": "nzd",
  NZD: "nzd",
  "A$": "aud",
  AUD: "aud",
  "CA$": "cad",
  CAD: "cad",
  "R$": "brl",
  BRL: "brl",
  HRK: "hrk",
  CLP: "clp",
  ARS: "ars",
  MXN: "mxn",
  PEN: "pen",
  COP: "cop",
  CHF: "chf",
};

const TOKEN = String.raw`(?:US\$|NZ\$|CA\$|A\$|R\$|€|£|\b(?:EUR|GBP|USD|NZD|AUD|CAD|BRL|HRK|CLP|ARS|MXN|PEN|COP|CHF)\b)`;
/** An amount in US style: comma groups of three, optional dot and two decimals. */
const NUMBER = String.raw`\d{1,3}(?:,\d{3})*(?:\.\d{2})?|\d+(?:\.\d{2})?`;
const MONEY = String.raw`${TOKEN} ?(?:${NUMBER})`;

type Money = { currency: string; amount: number };

function readNumber(digits: string, currency: string, mail: ArchivedMail): number {
  if (!new RegExp(`^(?:${NUMBER})$`).test(digits)) fail(mail, `unreadable amount «${digits}»`);
  const n = Math.round(Number(digits.replace(/,/g, "")) * 100) / 100;
  if (currency === "clp" && !Number.isInteger(n)) fail(mail, `pesos with cents «${digits}»`);
  if (!(n > 0)) fail(mail, `amount «${digits}» is not positive`);
  return n;
}

function readMoney(printed: string, mail: ArchivedMail): Money {
  const m = printed.match(new RegExp(`^(${TOKEN}) ?(${NUMBER})$`));
  if (!m) fail(mail, `unreadable amount «${printed}»`);
  const currency = TOKENS[m[1]!];
  if (!currency) fail(mail, `unknown currency «${m[1]}»`);
  return { currency, amount: readNumber(m[2]!, currency, mail) };
}

// ─── Dates ───────────────────────────────────────────────────────────────────

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
};

function month(name: string, mail: ArchivedMail): number {
  const n = MONTHS[name.toLowerCase().slice(0, name.toLowerCase().startsWith("sept") ? 4 : 3)];
  if (!n) fail(mail, `unknown month «${name}»`);
  return n;
}

function ymd(y: number, m: number, d: number): string {
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/** «2 September 2021», «Friday, October 6, 2023», «Tuesday, 8 July 2025» → YYYY-MM-DD. */
function readDate(s: string, mail: ArchivedMail): string {
  const dm = s.match(/^(?:[A-Za-z]+,? )?(\d{1,2}) ([A-Za-z]+),? (\d{4})$/);
  if (dm) return ymd(Number(dm[3]), month(dm[2]!, mail), Number(dm[1]));
  const md = s.match(/^(?:[A-Za-z]+,? )?([A-Za-z]+) (\d{1,2}),? (\d{4})$/);
  if (md) return ymd(Number(md[3]), month(md[1]!, mail), Number(md[2]));
  fail(mail, `unreadable date «${s}»`);
}

/** A date printed in words, as the stay mails write check-in and check-out. */
const DATE_WORDS = String.raw`(?:[A-Za-z]+,? )?(?:\d{1,2} [A-Za-z]+,? \d{4}|[A-Za-z]+ \d{1,2},? \d{4})`;

function nightsBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

function stayConcept(city: string, checkIn: string, checkOut: string, mail: ArchivedMail): string {
  const n = nightsBetween(checkIn, checkOut);
  if (!(n > 0)) fail(mail, `check-out ${checkOut} is not after check-in ${checkIn}`);
  return `${city}, ${checkIn} → ${checkOut} (${n} ${n === 1 ? "noche" : "noches"})`;
}

const chileClock = new Intl.DateTimeFormat("sv-SE", {
  timeZone: "America/Santiago",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

/** A zone as Airbnb prints it beside a payment («-03», «GMT-4», «CLST») → minutes east of UTC. */
function zoneOffsetMinutes(zone: string, mail: ArchivedMail): number {
  const named: Record<string, number> = { CLST: -180, CLT: -240, UTC: 0, GMT: 0 };
  if (zone in named) return named[zone]!;
  const m = zone.match(/^(?:GMT|UTC)?([+-])(\d{1,2})(?::?(\d{2}))?$/);
  if (!m) fail(mail, `unknown time zone «${zone}»`);
  return (m[1] === "-" ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3] ?? 0));
}

/** «Jan 28, 2020» «11:50PM» «-03» → the Chile clock. */
function chileStamp(date: string, time: string, zone: string, mail: ArchivedMail): string {
  const d = date.match(/^([A-Za-z]+) (\d{1,2}), (\d{4})$/);
  const t = time.match(/^(\d{1,2}):(\d{2}) ?([AP]M)$/i);
  if (!d || !t) fail(mail, `unreadable payment time «${date} ${time}»`);
  const hour = (Number(t[1]) % 12) + (t[3]!.toUpperCase() === "PM" ? 12 : 0);
  const utc = Date.UTC(Number(d[3]), month(d[1]!, mail) - 1, Number(d[2]), hour, Number(t[2])) - zoneOffsetMinutes(zone, mail) * 60_000;
  return chileClock.format(new Date(utc)).replace(",", "");
}

/** The city of an address «Calle Uno, 22, Barrio, Ciudad, 08010, Spain»: the part before the postcode. */
function cityOfAddress(address: string): string | null {
  const parts = address.split(",").map((p) => p.trim());
  for (let i = parts.length - 1; i > 0; i--) {
    if (/\d/.test(parts[i]!) && !/\d/.test(parts[i - 1]!)) return parts[i - 1]!;
  }
  return null;
}

function receipt(mail: ArchivedMail, processor: string, r: Omit<ProcessorReceipt, "message_id" | "sent_at_chile" | "processor">): ProcessorReceipt {
  return { message_id: mail.message_id, sent_at_chile: mail.sent_at_chile, processor, ...r };
}

// ─── Booking.com ─────────────────────────────────────────────────────────────

const BOOKING_CONFIRMED_SUBJECT = /Thanks! Your booking is confirmed at (.+)$/;
const BOOKING_UPDATED_SUBJECT = /^Your updated booking at (.+)$/;

/**
 * A Booking.com stay's confirmation or update. Booking's own flights («… flight confirmation»),
 * car rentals, messages and reminders come from the same sender and decode to null.
 */
function decodeBooking(mail: ArchivedMail): ProcessorReceipt | null {
  const confirmed = mail.subject.match(BOOKING_CONFIRMED_SUBJECT);
  const updated = mail.subject.match(BOOKING_UPDATED_SUBJECT);
  if (!confirmed && !updated) return null;
  const t = flatten(mail.text);
  const property = (confirmed ?? updated)![1]!.trim();
  const ref = t.match(/Confirmation(?: number)?: (\d{6,})/)?.[1] ?? fail(mail, "no confirmation number");
  const stay = t.match(new RegExp(`Check-in (${DATE_WORDS})\\b.*? Check-out (${DATE_WORDS})\\b`));
  if (!stay) fail(mail, "no check-in / check-out");
  const checkIn = readDate(stay[1]!, mail);
  const checkOut = readDate(stay[2]!, mail);
  const city =
    t.match(/Your [a-z ]+ in (.+?) is confirmed\b/)?.[1]?.trim() ??
    cityOfAddress(t.match(/Location (.+?) Phone\b/)?.[1] ?? t.match(/ ([^,]+(?:, [^,]+)+?) - Show directions\b/)?.[1] ?? "") ??
    fail(mail, "no city");

  const card = (digits: string | undefined) => (digits ? `••••${digits}` : null);
  let amount: number;
  let currency: string;
  let paidAt = mail.sent_at_chile;
  let charges: ProcessorReceipt["charges"] = null;
  let method: string | null = null;
  let descriptor: string | null = null;

  const paid = [...t.matchAll(new RegExp(`(?:\\d{1,2} [A-Za-z]{3,4} \\d{4} |[A-Za-z]{3} \\d{1,2}, \\d{4} )?•+ ?(\\d{4}) Paid (${MONEY})`, "g"))];
  const scheduled = t.match(new RegExp(`([A-Za-z]{3} \\d{1,2}, \\d{4}) •+ ?(\\d{4}) Scheduled (${MONEY})`));
  if (paid.length > 0) {
    // Booking took the payment: at booking, or (an update) again since.
    const moneys = paid.map((p) => readMoney(p[2]!, mail));
    currency = moneys[0]!.currency;
    if (moneys.some((x) => x.currency !== currency)) fail(mail, "payments in several currencies");
    amount = Math.round(moneys.reduce((s, x) => s + x.amount, 0) * 100) / 100;
    if (moneys.length > 1) charges = moneys.map((x) => ({ amount: x.amount, installments: null }));
    method = card(paid[paid.length - 1]![1]);
    descriptor = "Hotel at Booking.com";
  } else if (scheduled) {
    // Booking charges the card on a date it states (00:00 in the property's time zone); the
    // statement prints it «Booking.com Hotel».
    ({ amount, currency } = readMoney(scheduled[3]!, mail));
    paidAt = `${readDate(scheduled[1]!, mail)} 00:00`;
    method = card(scheduled[2]);
    descriptor = "Hotel at Booking.com";
  } else {
    // The property charges: a prepayment at any time, or at the stay.
    const price =
      t.match(new RegExp(`\\bPayment amount (${MONEY})`)) ??
      t.match(new RegExp(`\\bTotal [Pp]rice (${MONEY})`)) ??
      t.match(new RegExp(`\\b(?<!Total )Price (${MONEY})`)) ??
      fail(mail, "no price");
    ({ amount, currency } = readMoney(price[1]!, mail));
  }
  return receipt(mail, "booking", {
    payee: { name: property, rut: null, email: null },
    amount,
    currency,
    paid_at_chile: paidAt,
    order_ref: ref,
    concept: stayConcept(city, checkIn, checkOut, mail),
    stay: { check_in: checkIn, check_out: checkOut, city },
    statement_descriptor: descriptor,
    payment_method: method,
    installments: null,
    charges,
  });
}

// ─── Airbnb ──────────────────────────────────────────────────────────────────

const AIRBNB_CONFIRMED_SUBJECT = /^Reservation confirmed for (.+)$/;

/** The listing type Airbnb prints between the listing's name and its host. */
const LISTING_TYPE = String.raw`(?:Entire [a-z/ ]+|Private room(?: in [^,]+?)?|Shared room(?: in [^,]+?)?|Hotel room|Room in [^,]+?)`;

/**
 * «Reservation confirmed for <city>»: 2020–2021 «You're going to <city>! <listing> <type> hosted
 * by <host> Thursday, 6 February 2020 Check-in … Friday, 7 February 2020 Checkout … Payment 1 of 2
 * $15,400 Jan 28, 2020 · 11:50PM -03 Referral Credit Payment 2 of 2 $8,242 … MASTERCARD •••• 1234
 * Amount paid (CLP) $23,642 Reservation code HM…»; 2023 «You're all set for <city> … <listing>
 * <type> hosted by <host> Check-in Mon, 27 Nov 14:00 Checkout Fri, 1 Dec 10:00 … Payments
 * MASTERCARD •••••1234 Nov 26, 2023 · 04:22 PM CLST $362.87 Amount paid (USD) $362.87 …
 * Reservation code: HM…». The card's rows are the charge; credit and coupons are not.
 */
function decodeAirbnb(mail: ArchivedMail): ProcessorReceipt | null {
  const subject = mail.subject.match(AIRBNB_CONFIRMED_SUBJECT);
  if (!subject) return null;
  const city = subject[1]!.trim();
  const t = flatten(mail.text);
  const ref = t.match(/Reservation code:? (HM[A-Z0-9]{6,})/)?.[1] ?? fail(mail, "no reservation code");
  const listing =
    t.match(new RegExp(`(?:going to|all set for) ${escape(city)}!? (.+?) ${LISTING_TYPE} hosted by `))?.[1] ?? fail(mail, "no listing name");
  // The second «all set for <city>» of the 2023 layout repeats the heading.
  const name = listing.replace(new RegExp(`^.*all set for ${escape(city)} `), "").trim();
  const total = t.match(/Amount paid \(([A-Z]{3})\) /) ?? fail(mail, "no amount paid");
  const currency = total[1]!.toLowerCase();
  const block = t.slice(t.search(/\bPayments? /), t.indexOf(total[0]));

  const SYMBOL = String.raw`(?:[A-Z]{3} ?|[A-Z]{0,2}\$|[€£])`;
  const rows = [
    ...block.matchAll(
      new RegExp(
        String.raw`(?:Payment \d+ of \d+ (${SYMBOL}[\d,.]+) ([A-Za-z]{3} \d{1,2}, \d{4}) · (\d{1,2}:\d{2} ?[AP]M) (\S+) (.+?)(?= Payment \d+ of |$))|(?:(?:Payments |(?<=[\d.]) )(.+?) ([A-Za-z]{3} \d{1,2}, \d{4}) · (\d{1,2}:\d{2} ?[AP]M) (\S+) (${SYMBOL}[\d,.]+))`,
        "g"
      )
    ),
  ].map((m) =>
    m[1] != null
      ? { printed: m[1], date: m[2]!, time: m[3]!, zone: m[4]!, method: m[5]!.trim() }
      : { printed: m[10]!, date: m[7]!, time: m[8]!, zone: m[9]!, method: m[6]!.trim() }
  );
  if (rows.length === 0) fail(mail, "no payment rows");
  const cards = rows.filter((r) => /•+ ?\d{4}$/.test(r.method));
  // Paid with Airbnb credit or a coupon alone: the card was not charged.
  if (cards.length === 0) return null;
  const amounts = cards.map((r) => {
    const digits = r.printed.replace(/^\D+/, "");
    return readNumber(digits, currency, mail);
  });
  const amount = Math.round(amounts.reduce((s, x) => s + x, 0) * 100) / 100;
  const first = cards[0]!;

  // 2020–2021 print the year beside each date; 2023 prints «Mon, 27 Nov», dated from the payment.
  let checkIn: string;
  let checkOut: string;
  const full = t.match(new RegExp(`(${DATE_WORDS}) Check-?in\\b.*?(${DATE_WORDS}) Check-?out\\b`, "i"));
  const short = t.match(/Check-in [A-Za-z]{3}, (\d{1,2}) ([A-Za-z]{3,4}) .*?Checkout [A-Za-z]{3}, (\d{1,2}) ([A-Za-z]{3,4})\b/);
  if (full) {
    checkIn = readDate(full[1]!, mail);
    checkOut = readDate(full[2]!, mail);
  } else if (short) {
    const paidYear = Number(first.date.slice(-4));
    const paidMonth = month(first.date.slice(0, 3), mail);
    const inMonth = month(short[2]!, mail);
    const outMonth = month(short[4]!, mail);
    const inYear = inMonth < paidMonth ? paidYear + 1 : paidYear;
    checkIn = ymd(inYear, inMonth, Number(short[1]));
    checkOut = ymd(outMonth < inMonth ? inYear + 1 : inYear, outMonth, Number(short[3]));
  } else {
    fail(mail, "no check-in / checkout");
  }
  return receipt(mail, "airbnb", {
    payee: { name, rut: null, email: null },
    amount,
    currency,
    paid_at_chile: chileStamp(first.date, first.time, first.zone, mail),
    order_ref: ref,
    concept: stayConcept(city, checkIn, checkOut, mail),
    stay: { check_in: checkIn, check_out: checkOut, city },
    statement_descriptor: `AIRBNB * ${ref}`,
    payment_method: first.method.replace(/\s*•+\s*/, " ••••"),
    installments: null,
    charges: amounts.length > 1 ? amounts.map((a) => ({ amount: a, installments: null })) : null,
  });
}

function escape(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ─── Stripe receipts ─────────────────────────────────────────────────────────

const STRIPE_RECEIPT_SUBJECT = /^Your (.+) receipt \[#([\d-]+)\]$/;
/** Stripe prints dollars as «$» and every other dollar with its prefix («NZ$», «CA$»). */
const STRIPE_TOKENS: Record<string, string> = { $: "usd", "US$": "usd", "NZ$": "nzd", "A$": "aud", "CA$": "cad", "€": "eur", "£": "gbp", "R$": "brl", CLP: "clp" };

/**
 * «Your <merchant> receipt [#1234-5678]»: «Amount paid NZ$600.00 Date paid Nov 3, 2023, 3:13:51 PM
 * … Payment method - 1234 … Summary <item> NZ$600.00 … Amount charged NZ$600.00». The date is on
 * the merchant's clock and Stripe mails the receipt as it charges, so `paid_at_chile` is the mail's
 * time.
 */
function decodeStripeReceipt(mail: ArchivedMail): ProcessorReceipt | null {
  const subject = mail.subject.match(STRIPE_RECEIPT_SUBJECT);
  if (!subject) return null;
  const t = flatten(mail.text).replace(/(?:â\s*)+/g, " ").replace(/\s+/g, " ");
  const paid = t.match(/Amount (?:paid|charged) (US\$|NZ\$|A\$|CA\$|R\$|€|£|\$|CLP ?)(\d[\d,]*(?:\.\d{2})?)/) ?? fail(mail, "no amount paid");
  const currency = STRIPE_TOKENS[paid[1]!.trim()] ?? fail(mail, `unknown currency «${paid[1]}»`);
  const amount = readNumber(paid[2]!, currency, mail);
  const charged = t.match(/Amount charged (?:US\$|NZ\$|A\$|CA\$|R\$|€|£|\$|CLP ?)(\d[\d,]*(?:\.\d{2})?)/)?.[1];
  if (charged != null && readNumber(charged, currency, mail) !== amount) fail(mail, `amount paid ${paid[2]} ≠ amount charged ${charged}`);
  const item = t.match(/Summary (.+?) (?:US\$|NZ\$|A\$|CA\$|R\$|€|£|\$)\d/)?.[1]?.trim() || null;
  const card = t.match(/Payment method (?:[A-Za-z]+ )?- (\d{4})\b/)?.[1];
  return receipt(mail, "stripe", {
    payee: { name: subject[1]!.trim(), rut: null, email: null },
    amount,
    currency,
    paid_at_chile: mail.sent_at_chile,
    order_ref: `#${subject[2]}`,
    concept: item,
    // A Stripe receipt states what was bought, not the stay's dates.
    stay: null,
    statement_descriptor: null,
    payment_method: card ? `••••${card}` : null,
    installments: null,
    charges: null,
  });
}

// ─── Accor (ALL.com) ─────────────────────────────────────────────────────────

const ACCOR_CONFIRMED_SUBJECT = /^Confirmation of your reservation: (.+?) No\. ?([A-Z0-9]+)$/;

/**
 * «Confirmation of your reservation: <hotel> No.<ref>»: «Your stay <hotel> <street> - <postcode>
 * <CITY> - <country> … Date of stay: From 11 Jul 2025 to 15 Jul 2025 … Amount already paid: EUR
 * 525.79 Remaining amount to be paid at the hotel: EUR 15.02 … Total EUR 540.81». The card is
 * charged what was paid at booking; the rest is the hotel's, at the stay.
 */
function decodeAccor(mail: ArchivedMail): ProcessorReceipt | null {
  const subject = mail.subject.match(ACCOR_CONFIRMED_SUBJECT);
  if (!subject) return null;
  const hotel = subject[1]!.trim();
  const t = flatten(mail.text);
  const stay = t.match(/Date of stay: From (\d{1,2} [A-Za-z]+ \d{4}) to (\d{1,2} [A-Za-z]+ \d{4})/) ?? fail(mail, "no dates of stay");
  const address = t.match(new RegExp(`Your stay ${escape(hotel)} (.+?) \\S+@\\S+`))?.[1] ?? fail(mail, "no address");
  const parts = address.split(" - ");
  if (parts.length < 3) fail(mail, `unreadable address «${address}»`);
  const town = parts[parts.length - 2]!.replace(/^(?:[A-Z0-9]*\d[A-Z0-9]* )+(?:[A-Z]{2} )?/, "").trim();
  if (!town) fail(mail, `no city in «${address}»`);
  const city = town.toLowerCase().replace(/(^|[\s-])(\p{L})/gu, (_, a: string, b: string) => a + b.toUpperCase());
  const paid = t.match(new RegExp(`Amount already paid: (${MONEY})`));
  const total = t.match(new RegExp(`\\bTotal (${MONEY}) \\(fees and taxes included\\)`)) ?? fail(mail, "no total");
  const { amount, currency } = readMoney((paid ?? total)[1]!, mail);
  const checkIn = readDate(stay[1]!, mail);
  const checkOut = readDate(stay[2]!, mail);
  return receipt(mail, "accor", {
    payee: { name: hotel, rut: null, email: null },
    amount,
    currency,
    paid_at_chile: mail.sent_at_chile,
    order_ref: subject[2]!,
    concept: stayConcept(city, checkIn, checkOut, mail),
    stay: { check_in: checkIn, check_out: checkOut, city },
    statement_descriptor: null,
    payment_method: null,
    installments: null,
    charges: null,
  });
}

export const STAY_PROCESSORS: readonly PaymentProcessor[] = [
  {
    slug: "booking",
    from: "booking.com",
    wantSubject: (s) => BOOKING_CONFIRMED_SUBJECT.test(s) || BOOKING_UPDATED_SUBJECT.test(s),
    decode: decodeBooking,
  },
  { slug: "airbnb", from: "airbnb.com", wantSubject: (s) => AIRBNB_CONFIRMED_SUBJECT.test(s), decode: decodeAirbnb },
  {
    slug: "stripe",
    gmraw: 'subject:receipt "partners with Stripe"',
    wantSubject: (s) => STRIPE_RECEIPT_SUBJECT.test(s),
    decode: decodeStripeReceipt,
  },
  { slug: "accor", from: "confirmation.all.com", wantSubject: (s) => ACCOR_CONFIRMED_SUBJECT.test(s), decode: decodeAccor },
];
