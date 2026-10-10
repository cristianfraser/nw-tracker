/**
 * Uber's mails → canonical `payment.processor_receipts` receipts: each card charge «UBER *TRIP» /
 * «UBER EATS» / «PAYU *UBER EATS» linked to the ride (from → to) or the shop it paid, and the
 * monthly Uber One charge marked as a subscription.
 *
 * Uber has mailed six layouts since 2014, each with its own number style, read explicitly:
 *
 * - **2014 «Receipt #»** (`Uber Ride Receipt`): «Amount Charged $0,00» (Chilean grouping).
 * - **2014–2016 «<date> CLP2,051.00 Thanks for choosing Uber»**: «CHARGED Personal 1234 CLP2,051.00»
 *   (CLP / CL$ with US grouping and .00) or «$2.570,00» (Chilean, the Spanish-locale fare table).
 * - **2016–2018 «CLP1,723.00 Thanks for choosing Uber, … <date> | uberX 01:33am | <from> …»**:
 *   «CHARGED CLP1,723.00 Personal 1234», «CHARGED $4,074 Personal 1234» (US grouping) or «$685,00».
 * - **2018–2020 «Total: $6,248 Mon, Oct 08, 2018»**: «Amount Charged 1234 | Switch $6,248».
 * - **2020–2025 «Total CLP 5,936 September 15, 2020»**: «Amount Charged 1234 | Switch CLP 5,936», or
 *   a payments block «Mastercard ••••1234 12/15/23 12:42 AM CLP 12,120» (one row per charge, Uber
 *   Cash rows included). Since ~2021 a trip is first acknowledged by a «trip summary» («This is not
 *   a payment receipt»), and the receipt follows when the payment goes through.
 * - **2025 on «Sep 13, 2026 1:50 AM …»**: payments «Visa ••••1234 CLP 10,499 9/13/26 12:51 PM».
 *
 * A bare «$» is only read in the pre-2020 layouts, where it is the peso: «$685,00» (two decimals
 * after a comma) and «$4,074» (comma groups of three) cannot be mistaken for each other. The amount
 * is what the CARD was charged: Uber Cash and credit rows are left out, a mail that lists several
 * card charges (a tip or an adjustment added after the order, each with its own mail) carries the
 * last one, which is the one that mail announces. A ride or order the card paid nothing for, or one
 * in a currency other than pesos or dollars, decodes to null.
 *
 * The receipt's `order_ref` is Uber's `xid…` token when the mail prints it (every mail to 2020, and
 * every Uber Eats mail); the 2020-on trip mails print none, so the ref is the trip's own printed
 * start (`uber-trip:<YYYY-MM-DD HH:MM>`, the start of the ride for the 2020–2025 layout, the
 * request time the header prints for the 2025-on layout), which a summary and its receipt share.
 */
import type { ProcessorReceipt, ReceiptCharge, ReceiptTrip } from "nw-tracker-contracts";
import type { ArchivedMail } from "../email/santanderMailArchive.js";
import type { PaymentProcessor } from "./paymentReceiptMails.js";

function fail(mail: ArchivedMail, why: string): never {
  throw new Error(`${mail.sent_at_chile} «${mail.subject}» (${mail.message_id}): ${why}`);
}

/** The text as one line: HTML entities decoded, UTF-8 read as Latin-1 repaired («â€¢» → «•»), «Â » dropped. */
function flatten(text: string): string {
  return text
    .replace(/&#x([0-9a-f]+);/gi, (_, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&amp;/g, "&")
    .replace(/[Â-ô][\u0080-¿]{1,3}/g, (run) => {
      const fixed = Buffer.from(run, "latin1").toString("utf8");
      return fixed.includes("�") ? run : fixed;
    })
    .replace(/Â(?=\s)/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

// ─── Money ───────────────────────────────────────────────────────────────────

type Money = { currency: "clp" | "usd" | "other"; amount: number; printed: string };

/** A printed amount, with its currency token. */
const MONEY = String.raw`(?:CLP|CL\$|US\$|USD|R\$|NZ\$|A\$|ARS|BRL|HRK|EUR|GBP|MXN|PEN|COP|€|£|\$)\s?-?\d[\d.,]*\d`;

/**
 * «4,877» / «1,723.00»: comma groups of three, optional decimals. The 2016 receipts print centavos
 * when credit or a split fare left a fraction («CL$102.77», «CLP5,121.50»); the card is charged in
 * whole pesos, so they round.
 */
function usGroupedPesos(s: string): number | null {
  const m = s.match(/^(\d{1,3}(?:,\d{3})*)(?:\.(\d{2}))?$/);
  if (!m) return null;
  return Math.round(Number(m[1]!.replace(/,/g, "")) + Number(m[2] ?? 0) / 100);
}

/** «2.570,00» / «685,00» / «0,00»: dot groups of three, comma and two decimals. Cents round (2014: «$2.036,17»). */
function chileanPesosWithCents(s: string): number | null {
  const m = s.match(/^(\d{1,3}(?:\.\d{3})*),(\d{2})$/);
  if (!m) return null;
  return Math.round(Number(m[1]!.replace(/\./g, "")) + Number(m[2]) / 100);
}

/** «12.34» / «1,234.56»: dollars to the cent. */
function usDollars(s: string): number | null {
  const m = s.match(/^(\d{1,3}(?:,\d{3})*)\.(\d{2})$/);
  return m ? Number(m[1]!.replace(/,/g, "")) + Number(m[2]) / 100 : null;
}

/**
 * Reads one printed amount. `bareDollarSignIsPeso`: the pre-2020 layouts print pesos as «$»; the
 * later ones always name the currency, and a bare «$» there throws.
 */
function readMoney(printed: string, bareDollarSignIsPeso: boolean, mail: ArchivedMail): Money {
  const m = printed.match(/^(CLP|CL\$|US\$|USD|R\$|NZ\$|A\$|ARS|BRL|HRK|EUR|GBP|MXN|PEN|COP|€|£|\$)\s?(-?)(\d[\d.,]*\d)$/);
  if (!m) fail(mail, `unreadable amount «${printed}»`);
  const [, token, minus, digits] = m;
  if (minus) fail(mail, `negative charge «${printed}»`);
  let amount: number | null = null;
  let currency: Money["currency"];
  if (token === "CLP" || token === "CL$") {
    currency = "clp";
    amount = usGroupedPesos(digits!);
  } else if (token === "$") {
    if (!bareDollarSignIsPeso) fail(mail, `«${printed}» names no currency`);
    currency = "clp";
    amount = chileanPesosWithCents(digits!) ?? usGroupedPesos(digits!);
  } else if (token === "US$" || token === "USD") {
    currency = "usd";
    amount = usDollars(digits!);
  } else {
    // Rides and orders abroad: the card is charged in pesos at a rate the mail does not state.
    return { currency: "other", amount: 0, printed };
  }
  if (amount == null) fail(mail, `unreadable amount «${printed}»`);
  return { currency, amount, printed };
}

// ─── Dates ───────────────────────────────────────────────────────────────────

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

const pad = (n: number) => String(n).padStart(2, "0");

/** «September 15, 2020» / «Oct 08, 2018» / «Sep 2, 2026» → `YYYY-MM-DD`. */
function englishDate(s: string, mail: ArchivedMail): string {
  const m = s.match(/^([A-Z][a-z]+) (\d{1,2}), (\d{4})$/);
  const month = m ? MONTHS[m[1]!.slice(0, 3).toLowerCase()] : undefined;
  if (!m || !month) fail(mail, `unreadable date «${s}»`);
  return `${m[3]}-${pad(month)}-${pad(Number(m[2]))}`;
}

/** «09:14am» / «9:42 AM» / «12:07 AM» → `HH:MM`. */
function clock(s: string, mail: ArchivedMail): string {
  const m = s.match(/^(\d{1,2}):(\d{2}) ?([ap])m$/i);
  if (!m) fail(mail, `unreadable time «${s}»`);
  let h = Number(m[1]) % 12;
  if (m[3]!.toLowerCase() === "p") h += 12;
  return `${pad(h)}:${m[2]}`;
}

/** «12/15/23 12:42 AM» (month first) → `YYYY-MM-DD HH:MM`. */
function slashStamp(date: string, time: string, mail: ArchivedMail): string {
  const m = date.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2})$/);
  if (!m) fail(mail, `unreadable payment date «${date}»`);
  return `20${m[3]}-${pad(Number(m[1]))}-${pad(Number(m[2]))} ${clock(time, mail)}`;
}

function addDay(ymd: string): string {
  const d = new Date(`${ymd}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

/** Start and end stamps of a ride printed as a date and two clock times; an end before the start is the next day. */
function rideStamps(ymd: string, start: string, end: string | null): { started: string; ended: string | null } {
  const started = `${ymd} ${start}`;
  if (end == null) return { started, ended: null };
  return { started, ended: end < start ? `${addDay(ymd)} ${end}` : `${ymd} ${end}` };
}

// ─── Shared reading ──────────────────────────────────────────────────────────

const TIME = String.raw`\d{1,2}:\d{2} ?[apAP][mM]`;

/** Uber's own id for the trip or order: «xid9f30a410-7ba8-…» (2014: «xiddwzvqsde»). */
function xidOf(t: string): string | null {
  return t.match(/\b(xid[0-9a-z]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/)?.[1] ?? t.match(/\b(xid[a-z]{6,})\s*$/)?.[1] ?? null;
}

type Payment = { method: string; card: string | null; stamp: string | null; money: Money; refund: boolean };

/**
 * The charges a mail lists: the 2020–2025 «Payments» block («Mastercard ••••1234 12/15/23 12:42 AM
 * CLP 12,120», «Uber Cash 2/4/23 1:11 PM CLP 2,500»), the 2025-on one («Visa ••••1234 CLP 10,499
 * 9/13/26 12:51 PM») and the older «Amount Charged 1234 | Switch $9,390» rows.
 */
function paymentsOf(t: string, bareDollarSignIsPeso: boolean, mail: ArchivedMail): Payment[] {
  const out: Payment[] = [];
  const method = String.raw`((?:(?!Payments )[A-Z][A-Za-z]*\s)?(?:[A-Z][A-Za-z]*)\s?••••(\d{4})|Uber Cash|Uber Credits?|Gift Card)`;
  // A refund row prints a minus before its amount («Uber Cash 2/6/23 2:09 PM -CLP 5,990 Refund»).
  const before = new RegExp(String.raw`${method} (\d{1,2}\/\d{1,2}\/\d{2}) (${TIME}) (-?)(${MONEY})`, "g");
  const after = new RegExp(String.raw`${method} (-?)(${MONEY}) (\d{1,2}\/\d{1,2}\/\d{2}) (${TIME})`, "g");
  const found: { at: number; p: Payment }[] = [];
  for (const m of t.matchAll(before)) {
    const p: Payment = { method: m[1]!.trim(), card: m[2] ?? null, stamp: slashStamp(m[3]!, m[4]!, mail), money: readMoney(m[6]!, bareDollarSignIsPeso, mail), refund: m[5] === "-" };
    found.push({ at: m.index!, p });
  }
  for (const m of t.matchAll(after)) {
    const p: Payment = { method: m[1]!.trim(), card: m[2] ?? null, stamp: slashStamp(m[5]!, m[6]!, mail), money: readMoney(m[4]!, bareDollarSignIsPeso, mail), refund: m[3] === "-" };
    found.push({ at: m.index!, p });
  }
  out.push(...found.sort((a, b) => a.at - b.at).map((f) => f.p));
  if (out.length > 0) return out;
  // «Amount Charged 1234 | Switch $9,390 1234 | Switch $500», «Amount Charged Credits $2,200 1234 $5,288».
  const charged = t.match(new RegExp(String.raw`Amount Charged ((?:(?:Credits|\d{4}(?: \| Switch)?) (?:${MONEY}) ?)+)`));
  if (charged) {
    for (const m of charged[1]!.matchAll(new RegExp(String.raw`(Credits|\d{4})(?: \| Switch)? (${MONEY})`, "g"))) {
      const card = m[1] === "Credits" ? null : m[1]!;
      out.push({ method: card ? `••••${card}` : "Uber Credits", card, stamp: null, money: readMoney(m[2]!, bareDollarSignIsPeso, mail), refund: false });
    }
  }
  return out;
}

/** «Mastercard ••••1234», «Visa ••••1234»; an older layout prints only the last four. */
function methodLabel(p: Payment): string {
  return p.method.replace(/\s?••••/, " ••••").replace(/^ /, "");
}

type Charge =
  | { amount: number; currency: "clp" | "usd"; paidAt: string | null; method: string | null; charges: ReceiptCharge[] | null }
  | "nothing"
  | "foreign";

/** Minutes between two `YYYY-MM-DD HH:MM` stamps. */
function minutesBetween(a: string, b: string): number {
  return (Date.parse(`${b.replace(" ", "T")}:00Z`) - Date.parse(`${a.replace(" ", "T")}:00Z`)) / 60000;
}

/** Card charges this close to a mail's latest one belong to the same mail (a grocery order taken in two pieces, 7 minutes apart). */
const SAME_MAIL_CHARGE_WINDOW_MIN = 30;

/**
 * The card charges a mail announces. Uber mails a receipt each time it charges the card, and a
 * later mail of the same order repeats the earlier rows: a tip charged an hour after the order
 * (2021–2022 «Thanks for ordering» mails list both), an extra, an adjustment, a refund. So a mail
 * announces its latest card row plus any card row charged within 30 minutes before it (two pieces
 * of one grocery order); a row printed without a time (the pre-2021 «Amount Charged» rows) counts
 * only when it is the last. Uber Cash and credit rows are never the card's. A mail that says it
 * updates an earlier receipt announces only its last row, and nothing when that row is not a card
 * charge (a refund to Uber Cash).
 */
function announcedCharge(payments: Payment[], isUpdate: boolean, mail: ArchivedMail): Charge {
  let rows: Payment[];
  if (isUpdate) {
    rows = payments.slice(-1).filter((p) => p.card != null && !p.refund);
  } else {
    const cards = payments.filter((p) => p.card != null && !p.refund);
    const last = cards[cards.length - 1];
    rows = !last
      ? []
      : last.stamp == null
        ? [last]
        : cards.filter((p) => p.stamp != null && minutesBetween(p.stamp, last.stamp!) <= SAME_MAIL_CHARGE_WINDOW_MIN);
  }
  if (rows.length === 0) return "nothing";
  if (rows.every((p) => p.money.currency === "other")) return "foreign";
  const priced = rows.filter((p) => p.money.amount > 0);
  if (priced.length === 0) return "nothing";
  const currency = priced[0]!.money.currency;
  if (currency === "other" || priced.some((p) => p.money.currency !== currency)) fail(mail, "card charges in several currencies");
  const last = priced[priced.length - 1]!;
  const sum = priced.reduce((a, p) => a + p.money.amount, 0);
  return {
    amount: currency === "usd" ? Math.round(sum * 100) / 100 : sum,
    currency,
    paidAt: last.stamp,
    method: methodLabel(last),
    charges: priced.length > 1 ? priced.map((p) => ({ amount: p.money.amount, installments: null })) : null,
  };
}

/** A mail that repeats an earlier receipt's charges and adds one: a tip, an extra, an adjustment, a refund. */
function isUpdateMail(mail: ArchivedMail, t: string, payments: Payment[]): boolean {
  return (
    /^Thanks for giving an extra!/.test(mail.subject) ||
    /updated (?:your )?receipt|We made an adjustment|Your refund has been applied/.test(t) ||
    (/Thanks for tipping/.test(t) && payments.length > 1)
  );
}

function kmLabel(km: number | null): string | null {
  return km == null ? null : `${String(km).replace(".", ",")} km`;
}

function receipt(
  mail: ArchivedMail,
  processor: string,
  fields: Pick<ProcessorReceipt, "payee" | "amount" | "currency" | "paid_at_chile" | "order_ref" | "concept" | "payment_method"> & {
    trip?: ReceiptTrip | null;
    subscription?: boolean;
    charges?: ReceiptCharge[] | null;
  }
): ProcessorReceipt {
  return {
    message_id: mail.message_id,
    sent_at_chile: mail.sent_at_chile,
    processor,
    payee: fields.payee,
    amount: fields.amount,
    currency: fields.currency,
    paid_at_chile: fields.paid_at_chile,
    order_ref: fields.order_ref,
    concept: fields.concept ? fields.concept.slice(0, 300) : null,
    statement_descriptor: null,
    payment_method: fields.payment_method,
    installments: null,
    charges: fields.charges ?? null,
    ...(fields.trip !== undefined ? { trip: fields.trip } : {}),
    ...(fields.subscription ? { subscription: true } : {}),
  };
}

const UBER = { name: "Uber", rut: null, email: null };

// ─── Trips ───────────────────────────────────────────────────────────────────

const TRIP_SUBJECT = /\btrip with Uber$|^Uber Ride Receipt$|\bReceipt for canceled trip\b|^Your receipt$/;

type Ride = {
  ymd: string;
  start: string | null;
  end: string | null;
  from: string | null;
  to: string | null;
  km: number | null;
  product: string | null;
};

/** What a trip mail prints about the ride, per layout (`null` fields when not printed). */
function readRide(t: string, mail: ArchivedMail): Ride & { layout: "receipt#" | "choosing" | "choosing|" | "total:" | "total" | "header" } {
  // 2014 «Receipt #».
  if (/^Receipt #/.test(t)) {
    const req = t.match(new RegExp(String.raw`Trip Request Date ([A-Z][a-z]+ \d{1,2}, \d{4}) at (${TIME})`));
    if (!req) fail(mail, "no trip request date");
    return {
      layout: "receipt#",
      ymd: englishDate(req[1]!, mail),
      start: clock(req[2]!, mail),
      end: null,
      from: t.match(/Pickup Location (.+?) (?:Dropoff Location|Payment )/)?.[1] ?? null,
      to: t.match(/Dropoff Location (.+?) Payment /)?.[1] ?? null,
      km: numberOrNull(t.match(/Distance ([\d.]+) kilometers/)?.[1]),
      product: null,
    };
  }
  // 2016–2018: «… Thanks for choosing Uber, Ana December 10, 2016 | uberX 01:33am | <from> 01:50am | <to> You rode with …».
  const piped = t.match(
    new RegExp(String.raw`Thanks for choosing Uber, .*?([A-Z][a-z]+ \d{1,2}, \d{4}) \| (.+?) (${TIME}) \| (.+?) (${TIME}) \| (.+?) You (?:rode with|ordered from)`)
  );
  if (piped) {
    return {
      layout: "choosing|",
      ymd: englishDate(piped[1]!, mail),
      start: clock(piped[3]!, mail),
      end: clock(piped[5]!, mail),
      from: piped[4]!,
      to: piped[6]!,
      km: numberOrNull(t.match(/([\d.]+) kilometers \d{2}:\d{2}:\d{2} Trip time/)?.[1]),
      product: piped[2]!.replace(/ \| .*$/, ""),
    };
  }
  // 2014–2016: «May 21, 2016 CLP2,051.00 Thanks for choosing Uber, Ana 08:03pm <from> 08:12pm <to> CAR uberX kilometers 2.19».
  const choosing = t.match(/^([A-Z][a-z]+ \d{1,2}, \d{4}) .*?(?:Thanks for choosing Uber|We'll connect another time)/);
  if (choosing) {
    const ymd = englishDate(choosing[1]!, mail);
    const ride = t.match(new RegExp(String.raw`(\d{2}:\d{2}[ap]m) (.+?) (\d{2}:\d{2}[ap]m) (.+?) CAR (\S+) kilometers ([\d.]+)`));
    if (ride) {
      return { layout: "choosing", ymd, start: clock(ride[1]!, mail), end: clock(ride[3]!, mail), from: ride[2]!, to: ride[4]!, km: Number(ride[6]), product: ride[5]! };
    }
    return { layout: "choosing", ymd, start: null, end: null, from: null, to: null, km: null, product: null };
  }
  // 2018–2020: «Total: $6,248 Mon, Oct 08, 2018 …» / «Total: CLP2,254 November 22, 2019 …» / «Cancellation Fee: $1,100 Tue, Mar 26, 2019».
  const colon = t.match(/^(?:Total|Cancellation Fee): \S+ (?:[A-Z][a-z]{2}, )?([A-Z][a-z]+ \d{1,2}, \d{4}) /);
  // 2020–2025: «Total CLP 5,936 September 15, 2020 …» / «Cancellation Fee R$3.00 October 17, 2021».
  const total = colon ? null : t.match(new RegExp(String.raw`^(?:Total|Cancellation Fee) ${MONEY} ([A-Z][a-z]+ \d{1,2}, \d{4}) `));
  if (colon || total) {
    const ymd = englishDate((colon ?? total)![1]!, mail);
    const ride = t.match(
      new RegExp(
        String.raw`((?:Uber )?[A-Za-z][\w+-]*) ([\d.]+) (?:km|kilometers) \| \d+ min(?:utes?)? (${TIME}) (.+?) (${TIME}) (.+?) (?:Invite your friends|Report lost item|Contact support)`
      )
    );
    const base = { layout: colon ? ("total:" as const) : ("total" as const), ymd };
    if (ride) return { ...base, start: clock(ride[3]!, mail), end: clock(ride[5]!, mail), from: ride[4]!, to: ride[6]!, km: Number(ride[2]), product: ride[1]! };
    return { ...base, start: null, end: null, from: null, to: null, km: null, product: null };
  }
  // 2025 on: «Sep 13, 2026 1:50 AM Sep 13, 2026 , 1:50 AM …», ride under «Trip details Priority 7.91 kilometers, 15 minutes 1:57 AM <from> 2:13 AM <to> 1:57 AM …».
  const header = t.match(new RegExp(String.raw`^([A-Z][a-z]{2} \d{1,2}, \d{4}) (${TIME}) `));
  if (header) {
    const ymd = englishDate(header[1]!, mail);
    const requested = clock(header[2]!, mail);
    const ride = t.match(new RegExp(String.raw`Trip details (.+?) ([\d.]+) kilometers, \d+ minutes? (${TIME}) (.+?) (${TIME}) (.+?) \3 `));
    if (ride) {
      const start = clock(ride[3]!, mail);
      // The ride starts after the request: a start «before» it is past midnight.
      return { layout: "header", ymd: start < requested ? addDay(ymd) : ymd, start, end: clock(ride[5]!, mail), from: ride[4]!, to: ride[6]!, km: Number(ride[2]), product: ride[1]! };
    }
    return { layout: "header", ymd, start: requested, end: null, from: null, to: null, km: null, product: null };
  }
  fail(mail, "unknown trip layout");
}

function numberOrNull(s: string | undefined): number | null {
  return s == null ? null : Number(s);
}

/** A trip mail: a receipt, or (`summary`) the 2021-on summary that says it is not one. */
function decodeTripMail(mail: ArchivedMail, want: "receipt" | "summary"): ProcessorReceipt | null {
  if (!TRIP_SUBJECT.test(mail.subject)) return null;
  const t = flatten(mail.text);
  const isSummary = /This is not a payment receipt/.test(t);
  if (isSummary !== (want === "summary")) return null;
  const cancelled = /Receipt for canceled trip|^Cancellation Fee/.test(mail.subject) || /^Cancellation Fee\b/.test(t);
  if (mail.subject === "Your receipt" && !cancelled) fail(mail, "«Your receipt» that is not a cancellation");
  const ride = readRide(t, mail);
  const preTotalLayout = ride.layout !== "total" && ride.layout !== "header";

  let amount: number;
  let currency: "clp" | "usd";
  let paidAt: string | null = null;
  let method: string | null = null;
  let charges: ReceiptCharge[] | null = null;
  if (isSummary) {
    // A summary states the total to be charged and the card held: «Total CLP 4,877», «payment method 1234».
    const tot = t.match(new RegExp(String.raw`Total (${MONEY})`));
    if (!tot) fail(mail, "summary without a total");
    const money = readMoney(tot[1]!, false, mail);
    if (money.currency === "other" || money.amount === 0) return null;
    amount = money.amount;
    currency = money.currency;
    const held = t.match(/payment method (\d{4})/)?.[1];
    method = held ? `••••${held}` : null;
  } else {
    let charge: Charge;
    if (ride.layout === "receipt#") {
      const m = t.match(/Amount Charged (\$[\d.,]+)/) ?? fail(mail, "no amount charged");
      const money = readMoney(m[1]!, true, mail);
      charge = money.amount === 0 ? "nothing" : { amount: money.amount, currency: money.currency as "clp", paidAt: null, method: null, charges: null };
      const card = t.match(/Payment Personal (\w+) - (\d{4})/);
      if (typeof charge === "object" && card) charge.method = `${card[1]} ••••${card[2]}`;
    } else if (ride.layout === "choosing" || ride.layout === "choosing|") {
      const m =
        t.match(new RegExp(String.raw`CHARGED (?:Personal (\d{4}) )?(${MONEY})(?: Personal (\d{4}))?`)) ?? fail(mail, "no CHARGED amount");
      const money = readMoney(m[2]!, true, mail);
      const card = m[1] ?? m[3];
      charge =
        money.currency === "other"
          ? "foreign"
          : money.amount === 0
            ? "nothing"
            : { amount: money.amount, currency: money.currency, paidAt: null, method: card ? `••••${card}` : null, charges: null };
    } else {
      const payments = paymentsOf(t, preTotalLayout, mail);
      if (payments.length === 0) fail(mail, "no payment listed");
      charge = announcedCharge(payments, isUpdateMail(mail, t, payments), mail);
    }
    if (charge === "nothing" || charge === "foreign") return null;
    ({ amount, currency, paidAt, method, charges } = charge);
  }

  const stamps = ride.start != null ? rideStamps(ride.ymd, ride.start, ride.end) : null;
  if (cancelled) {
    const at = t.match(new RegExp(String.raw`(${TIME}) Request canceled`))?.[1];
    return receipt(mail, want === "summary" ? "uber_trip_summary" : "uber", {
      payee: UBER,
      amount,
      currency,
      paid_at_chile: paidAt ?? (at ? `${ride.ymd} ${clock(at, mail)}` : mail.sent_at_chile),
      order_ref: xidOf(t),
      concept: "Uber · cancellation fee",
      payment_method: method,
      charges,
      trip: null,
    });
  }
  const trip: ReceiptTrip | null =
    ride.from && ride.to
      ? { from: ride.from, to: ride.to, started_at_chile: stamps?.started ?? null, ended_at_chile: stamps?.ended ?? null, distance_km: ride.km }
      : null;
  const ref =
    xidOf(t) ??
    (ride.layout === "total" || ride.layout === "header"
      ? `uber-trip:${ride.layout === "header" ? `${ride.ymd} ${headerClock(t, mail)}` : stamps?.started ?? fail(mail, "no trip start to name the trip by")}`
      : null);
  const product = ride.product ? ride.product.replace(/^uber/, "Uber") : "Uber";
  return receipt(mail, want === "summary" ? "uber_trip_summary" : "uber", {
    payee: UBER,
    amount,
    currency,
    paid_at_chile: paidAt ?? stamps?.ended ?? stamps?.started ?? mail.sent_at_chile,
    order_ref: ref,
    concept: [product, kmLabel(ride.km)].filter((x) => x != null).join(" · "),
    payment_method: method,
    charges,
    trip,
  });
}

/** The 2025-on header's own date and time («Sep 13, 2026 1:50 AM»): what a summary and its receipt share. */
function headerClock(t: string, mail: ArchivedMail): string {
  const header = t.match(new RegExp(String.raw`^[A-Z][a-z]{2} \d{1,2}, \d{4} (${TIME}) `)) ?? fail(mail, "no header time");
  return clock(header[1]!, mail);
}

// ─── Uber Eats ───────────────────────────────────────────────────────────────

/** Order mails, a tip or an extra added to one, and Uber's grocery orders — never a job ad naming Uber Eats. */
const EATS_SUBJECT = /\border with Uber Eats$|\bgrocery order with Uber$|^Thanks for giving an extra!/;

/** The shop: «Here's your receipt for Pizzería Uno (Centro).», else «You ordered from …». */
function shopOf(t: string): string | null {
  const here = t.match(/(?:Here's your (?:updated )?|We updated your )receipt for (?:- )?(.+?)\.? (?:Rate order|Total |To view|Payments )/)?.[1];
  if (here) return here.trim();
  const ordered = t.match(/You ordered from (.+?) (?:Delivered to|Picked up from|Delivered by|Contact support|Switch Payment|Rate order|\d+\.\d+ kilometers|$)/)?.[1];
  return ordered && ordered !== "UberEATS" ? ordered.trim() : null;
}

/** Items as the 2018–2021 receipts list them: «… receipt for X. Total $9,890 1 Pizza Margarita $7,990 … Subtotal». */
function itemsOf(t: string): string | null {
  const block = t.match(new RegExp(String.raw`receipt for .+? Total ${MONEY} (.+?) Subtotal\b`))?.[1];
  if (!block || /To view your full receipt|Payments |Amount Charged/.test(block)) return null;
  const items = block
    .split(new RegExp(String.raw` ?${MONEY}(?: |$)`))
    .map((x) => x.trim())
    .filter((x) => x.length > 0);
  return items.length > 0 ? items.join(" · ") : null;
}

/**
 * An Uber Eats (or Uber grocery) mail: a receipt, or (`summary`) the 2021–2022 order summary that
 * says it is not one — some orders of mid-2021 got only summaries. The payee is the shop; the
 * concept, the items when the mail lists them (2018–2021), or «Tip or adjustment» for a mail that
 * adds a charge to an order already mailed.
 */
function decodeEatsMail(mail: ArchivedMail, want: "receipt" | "summary"): ProcessorReceipt | null {
  if (!EATS_SUBJECT.test(mail.subject)) return null;
  const t = flatten(mail.text);
  const isSummary = /This is not a payment receipt/.test(t);
  if (isSummary !== (want === "summary")) return null;
  const slug = want === "summary" ? "uber_eats_summary" : "uber_eats";

  // 2017: the order rides the trip layout («You ordered from UberEATS … CHARGED $11,300 Personal 1234»).
  if (/Thanks for choosing Uber/.test(t)) {
    const ride = readRide(t, mail);
    const m = t.match(new RegExp(String.raw`CHARGED (${MONEY})(?: Personal (\d{4}))?`)) ?? fail(mail, "no CHARGED amount");
    const money = readMoney(m[1]!, true, mail);
    if (money.currency === "other" || money.amount === 0) return null;
    const stamps = ride.start ? rideStamps(ride.ymd, ride.start, ride.end) : null;
    const items = t.match(/inquiries\. (.+?) Subtotal /)?.[1]?.replace(/ \d+\.\d{2}\b/g, "").trim() ?? null;
    return receipt(mail, slug, {
      payee: { name: shopOf(t) ?? "Uber Eats", rut: null, email: null },
      amount: money.amount,
      currency: money.currency,
      paid_at_chile: stamps?.ended ?? mail.sent_at_chile,
      order_ref: xidOf(t),
      concept: items,
      payment_method: m[2] ? `••••${m[2]}` : null,
    });
  }

  const shop = shopOf(t) ?? fail(mail, "no shop named");
  const payments = paymentsOf(t, /^Total: /.test(t), mail);
  const isUpdate = isUpdateMail(mail, t, payments);
  let charge: Charge;
  if (payments.length > 0) {
    charge = announcedCharge(payments, isUpdate, mail);
  } else if (isSummary) {
    // A 2022 summary lists no payment: it states the total to be charged.
    const tot = t.match(new RegExp(String.raw`Total (${MONEY})`)) ?? fail(mail, "summary without a total");
    const money = readMoney(tot[1]!, false, mail);
    charge =
      money.currency === "other" ? "foreign" : money.amount === 0 ? "nothing" : { amount: money.amount, currency: money.currency, paidAt: null, method: null, charges: null };
  } else if (/Uber Cash|Uber Credit/.test(t)) {
    // Paid in full by Uber Cash or credit: no card row at all.
    charge = "nothing";
  } else {
    fail(mail, "no payment listed");
  }
  if (charge === "nothing" || charge === "foreign") return null;

  const header = t.match(new RegExp(String.raw`^([A-Z][a-z]{2} \d{1,2}, \d{4}) (${TIME}) `));
  const completed = t.match(new RegExp(String.raw`Order completed ([A-Z][a-z]{2} \d{1,2}, \d{4}) at (${TIME})`));
  const orderedAt = completed
    ? `${englishDate(completed[1]!, mail)} ${clock(completed[2]!, mail)}`
    : header
      ? `${englishDate(header[1]!, mail)} ${clock(header[2]!, mail)}`
      : null;
  const ref = xidOf(t) ?? (header ? `uber-order:${englishDate(header[1]!, mail)} ${clock(header[2]!, mail)}` : null);
  return receipt(mail, slug, {
    payee: { name: shop, rut: null, email: null },
    amount: charge.amount,
    currency: charge.currency,
    paid_at_chile: charge.paidAt ?? orderedAt ?? mail.sent_at_chile,
    order_ref: ref,
    concept: isUpdate ? "Tip or adjustment" : itemsOf(t),
    payment_method: charge.method,
    charges: charge.charges,
  });
}

// ─── Uber One ────────────────────────────────────────────────────────────────

const UBER_ONE_SUBJECT = /^Uber One payment confirmation$|^Tu Uber Pass está listo$/;

/**
 * Uber One's monthly charge: «Total charged (includes VAT tax) CLP 3,990 Payment method MasterCard
 * **1234 Valid until Mar 8, 2023 at 1:54 PM»; its 2021 predecessor Uber Pass: «Total cobrado CLP
 * 5,990 Método de pago MasterCard **1234».
 */
function decodeUberOne(mail: ArchivedMail): ProcessorReceipt | null {
  if (!UBER_ONE_SUBJECT.test(mail.subject)) return null;
  const t = flatten(mail.text);
  const pass = /^Tu Uber Pass/.test(mail.subject);
  const m =
    t.match(
      pass
        ? new RegExp(String.raw`Total cobrado (${MONEY}) Método de pago (.+?) Fecha de expiración`)
        : new RegExp(String.raw`Total charged \(includes VAT tax\) (${MONEY}) Payment method (.+?) Valid until`)
    ) ?? fail(mail, "no total charged");
  const money = readMoney(m[1]!, false, mail);
  if (money.currency === "other" || money.amount === 0) return null;
  const card = m[2]!.match(/^([A-Za-z]+) (?:\*\*|••••)(\d{4})$/);
  return receipt(mail, "uber_one", {
    payee: UBER,
    amount: money.amount,
    currency: money.currency,
    paid_at_chile: mail.sent_at_chile,
    order_ref: null,
    concept: pass ? "Uber Pass" : "Uber One",
    payment_method: card ? `${card[1]} ••••${card[2]}` : m[2]!,
    subscription: true,
  });
}

// ─── Processors ──────────────────────────────────────────────────────────────

const UBER_GMRAW = 'from:uber.com subject:(trip OR order OR receipt OR "Uber One" OR "Uber Pass")';

export const UBER_PROCESSORS: readonly PaymentProcessor[] = [
  { slug: "uber", gmraw: UBER_GMRAW, wantSubject: (s) => TRIP_SUBJECT.test(s), decode: (m) => decodeTripMail(m, "receipt") },
  { slug: "uber_trip_summary", gmraw: UBER_GMRAW, wantSubject: (s) => TRIP_SUBJECT.test(s), decode: (m) => decodeTripMail(m, "summary") },
  { slug: "uber_eats", gmraw: UBER_GMRAW, wantSubject: (s) => EATS_SUBJECT.test(s), decode: (m) => decodeEatsMail(m, "receipt") },
  { slug: "uber_eats_summary", gmraw: UBER_GMRAW, wantSubject: (s) => EATS_SUBJECT.test(s), decode: (m) => decodeEatsMail(m, "summary") },
  { slug: "uber_one", gmraw: UBER_GMRAW, wantSubject: (s) => UBER_ONE_SUBJECT.test(s), decode: decodeUberOne },
];
