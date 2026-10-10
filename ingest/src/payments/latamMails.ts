/**
 * LATAM Airlines' purchase mails → canonical `payment.processor_receipts` receipts.
 *
 * The card names a LATAM charge «LATAM.COM XP INTER», «LATAM.COM OTRAS», «LAN COM» or
 * «LANCHILE…»; the airline's mail says what it bought: the route, the dates, who flies and the
 * booking code. Two kinds of document:
 *
 * - `latam`: a purchase — a ticket, or extras added to a trip. Layouts:
 *   «Confirmacion de compra» (compras@bo.lan.com, 2018–2021: «Tu código de reserva es: X …
 *   Pasajeros: … Precio $ 445.842 (CLP) Itinerario …»), «E-Ticket Confirmation» (sales@bo.lan.com,
 *   the same in English, priced in dollars, no itinerary), «Confirmación compra»
 *   (info@mail.latam.com / info@info.latam.com, 2021–2023: «Nº de Orden: … Total $239883.00», the
 *   route in a sentence, or «El pago de tus adicionales … Total CLP $64288.00») and «Ya compraste tu
 *   viaje a X» (2025 on: order, booking code, itinerary, passengers, «Total: CLP 1.856.030», or
 *   «Total: Millas 9.667 + CLP 96.052» for a ticket paid partly in miles). «Informacion de tu
 *   compra» (compras@bo.latam.com, 2021) states nothing in its text — the purchase is in a PDF the
 *   archive does not keep — so it decodes to null.
 * - `latam_change`: a ticket change, which may charge a fare difference: «Tu cambio de pasaje está
 *   listo.» (2021: the new itinerary, «Total Pagado: $724 (CLP)»), «Tu cambio está listo» (2025:
 *   «Total CLP $182.702»). «Tu cambio se realizó con éxito» states no payment and decodes to null,
 *   as does a change whose total is 0.
 *
 * None of them prints the time of the purchase: each is mailed the moment it goes through, so it is
 * dated by the mail. A mail of these senders that is not a purchase (a pending reservation,
 * check-in, boarding pass, marketing) decodes to null; a purchase mail this cannot read throws.
 */
import type { ProcessorReceipt } from "nw-tracker-contracts";
import type { ArchivedMail } from "../email/santanderMailArchive.js";
import type { PaymentProcessor } from "./paymentReceiptMails.js";

/** Every LATAM sender that has mailed a purchase or a change. */
const LATAM_PURCHASE_SENDERS = "from:(compras@bo.lan.com OR compras@bo.latam.com OR sales@bo.lan.com OR info@mail.latam.com OR info@info.latam.com)";

const LATAM_PURCHASE_SUBJECT =
  /^(?:Confirmaci[oó]n de compra|Confirmaci[oó]n compra|E-Ticket Confirmation|Informaci[oó]n de tu compra)$|^Ya compraste tu viaje\b/i;
const LATAM_CHANGE_SUBJECT = /^Tu cambio (?:de pasaje )?(?:est[aá] listo|se realiz[oó] con [eé]xito)\b/i;

function fail(mail: ArchivedMail, why: string): never {
  throw new Error(`${mail.sent_at_chile} «${mail.subject}»: ${why}`);
}

/**
 * Whole pesos as LATAM prints them: grouped («445.842», «1.856.030»), ungrouped («724») or with
 * zero cents («64288.00»). Two digits after the mark are cents, three a thousands group.
 */
function latamPesos(s: string, mail: ArchivedMail): number {
  const m = /^(\d{1,3}(?:\.\d{3})+|\d+)(?:[.,](\d{2}))?$/.exec(s);
  if (!m) fail(mail, `not a peso amount: ${s}`);
  if (m[2] != null && m[2] !== "00") fail(mail, `peso amount with cents: ${s}`);
  return Number(m[1]!.replace(/\./g, ""));
}

function latamDollars(s: string, mail: ArchivedMail): number {
  const m = /^(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?$/.exec(s);
  if (!m) fail(mail, `not a dollar amount: ${s}`);
  return Number(`${m[1]!.replace(/,/g, "")}.${m[2] ?? "0"}`);
}

const MONTHS: Record<string, string> = {
  ene: "01", enero: "01", feb: "02", febrero: "02", mar: "03", marzo: "03", abr: "04", abril: "04",
  may: "05", mayo: "05", jun: "06", junio: "06", jul: "07", julio: "07", ago: "08", agosto: "08",
  sep: "09", sept: "09", septiembre: "09", setiembre: "09", oct: "10", octubre: "10",
  nov: "11", noviembre: "11", dic: "12", diciembre: "12",
};

function ymd(day: string, month: string, year: string, mail: ArchivedMail): string {
  const mm = MONTHS[month.toLowerCase().replace(/\.$/, "")];
  if (!mm) fail(mail, `unknown month «${month}»`);
  return `${year}-${mm}-${day.padStart(2, "0")}`;
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** One journey: its places in order (origin, connections, destination) and its departure day. */
type Journey = { places: string[]; date: string | null };

function journeyText(j: Journey): string {
  return `${j.places.join(" → ")}${j.date ? ` ${j.date}` : ""}`;
}

function concept(parts: (string | null | undefined)[]): string | null {
  const kept = parts.filter((p): p is string => !!p && p.trim() !== "");
  return kept.length > 0 ? kept.join(" · ").slice(0, 300) : null;
}

function receipt(
  mail: ArchivedMail,
  processor: string,
  fields: { amount: number; currency: "clp" | "usd"; order_ref: string | null; concept: string | null }
): ProcessorReceipt {
  return {
    message_id: mail.message_id,
    sent_at_chile: mail.sent_at_chile,
    processor,
    payee: { name: "LATAM Airlines", rut: null, email: null },
    amount: fields.amount,
    currency: fields.currency,
    // No layout prints the purchase time; each is mailed the moment the payment goes through.
    paid_at_chile: mail.sent_at_chile,
    order_ref: fields.order_ref,
    concept: fields.concept,
    statement_descriptor: null,
    payment_method: null,
    installments: null,
    charges: null,
  };
}

// ─── 2018–2021: «Confirmacion de compra» / «E-Ticket Confirmation» ───────────

/**
 * «Lunes 28 mayo 2018 21:35 Santiago de Chile (SCL) 08:10 (Martes) Nueva York (JFK) LA532»; a
 * connection repeats the leg without its date («07:45 Lima (LIM) 13:25 Santiago de Chile (SCL) LA635»).
 */
const BO_LEG =
  /(?:\p{L}+ (\d{1,2}) (\p{L}+) (\d{4}) )?\d{2}:\d{2} [^()]+? \(([A-Z]{3})\) \d{2}:\d{2}(?: \(\p{L}+\))? [^()]+? \(([A-Z]{3})\) [A-Z0-9]{2}\d+/gu;

function boJourneys(itinerary: string, mail: ArchivedMail): Journey[] {
  const journeys: Journey[] = [];
  for (const m of itinerary.matchAll(BO_LEG)) {
    const [, day, month, year, from, to] = m;
    if (day != null) {
      journeys.push({ places: [from!, to!], date: ymd(day, month!, year!, mail) });
    } else {
      const last = journeys.at(-1);
      if (!last) fail(mail, "a connecting leg before any dated one");
      if (last.places.at(-1) !== from) fail(mail, `connection from ${from} after a leg to ${last.places.at(-1)}`);
      last.places.push(to!);
    }
  }
  return journeys;
}

function decodeBoPurchase(mail: ArchivedMail, t: string): ProcessorReceipt {
  const code = /(?:Tu código de reserva es|Your reservation code is): ([A-Z0-9]{6})\b/.exec(t)?.[1];
  if (!code) fail(mail, "no booking code");
  const passengers = /(?:Pasajeros|Passengers): (.+?) (?:Precio|Price) /.exec(t)?.[1]?.trim();
  const clp = /(?:Precio|Price) \$ ?([\d.,]+) \(CLP\)/.exec(t);
  const usd = /(?:Precio|Price) US\$ ?([\d.,]+) \(USD\)/.exec(t);
  if (!clp === !usd) fail(mail, "no price in CLP or USD");
  const itinerary = /Itinerario (.+?)(?: Informaci[oó]n importante| Si tu equipaje| Antes de viajar| Prep[aá]rate| Si t[uú]|$)/.exec(t)?.[1];
  const journeys = itinerary ? boJourneys(itinerary, mail) : [];
  if (itinerary && journeys.length === 0) fail(mail, "an itinerary with no flight in it");
  return receipt(mail, "latam", {
    amount: clp ? latamPesos(clp[1]!, mail) : latamDollars(usd![1]!, mail),
    currency: clp ? "clp" : "usd",
    order_ref: code,
    concept: concept([...journeys.map(journeyText), passengers]),
  });
}

// ─── 2021–2023: «Confirmación compra» ────────────────────────────────────────

/** «Total $239883.00», «Total CLP $64288.00», «Total 178418 millas + $82.069». */
const ORDER_TOTAL = /\bTotal (?:([\d.]+) millas \+ )?(CLP |USD )?\$ ?([\d.,]+)/;

function decodeOrderPurchase(mail: ArchivedMail, t: string): ProcessorReceipt {
  const order = /N[º°] de [Oo]rden:? (LA[0-9A-Z]+)/.exec(t)?.[1];
  if (!order) fail(mail, "no order number");
  const total = ORDER_TOTAL.exec(t);
  if (!total) fail(mail, "no total");
  // LATAM's Chilean site prints pesos as a bare «$»; a dollar total names its currency.
  const currency = total[2]?.trim() === "USD" ? "usd" : "clp";
  const amount = currency === "usd" ? latamDollars(total[3]!, mail) : latamPesos(total[3]!, mail);
  const route = /viaje de (.+?) a (.+?)\. N[º°] de [Oo]rden/.exec(t);
  const what = route ? `${route[1]} → ${route[2]}` : /pago de tus adicionales/i.test(t) ? "Adicionales del viaje" : null;
  if (!what) fail(mail, "neither a route nor extras");
  return receipt(mail, "latam", { amount, currency, order_ref: order, concept: concept([what, total[1] ? `+ ${total[1]} millas` : null]) });
}

// ─── 2025 on: «Ya compraste tu viaje a X» ────────────────────────────────────

const STAMP = /(\d{1,2}) (\p{L}+)\.? (\d{4}) \d{2}:\d{2} /gu;

/** «Vuelo de ida 29 jun 2025 19:00 Santiago de Chile LA706 … Cambio de avión en: Madrid … 30 jun 2025 17:15 Londres». */
function tripJourney(part: string, mail: ArchivedMail): Journey {
  const stamps = [...part.matchAll(STAMP)];
  if (stamps.length < 2) fail(mail, `a flight without departure and arrival: «${part.slice(0, 80)}»`);
  const first = stamps[0]!;
  const last = stamps.at(-1)!;
  const place = (s: string) => {
    const code = /\(([A-Z]{3})\)/.exec(s)?.[1];
    return code ?? s.trim();
  };
  const origin = place(/^(.+?) [A-Z0-9]{2}\d+\b/.exec(part.slice(first.index! + first[0].length))?.[1] ?? fail(mail, "no origin"));
  const destination = place(part.slice(last.index! + last[0].length));
  const via = [...part.matchAll(/Cambio de avi[oó]n en: (.+?) [A-Z0-9]{2}\d+\b/g)].map((m) => m[1]!.trim());
  return { places: [origin, ...via, destination], date: ymd(first[1]!, first[2]!, first[3]!, mail) };
}

function decodeTripPurchase(mail: ArchivedMail, t: string): ProcessorReceipt {
  const order = /N[º°] de orden: (LA[0-9A-Z]+)/.exec(t)?.[1];
  if (!order) fail(mail, "no order number");
  const code = /C[oó]digo de reserva: ([A-Z0-9]{6})\b/.exec(t)?.[1] ?? null;
  const total = /Informaci[oó]n de pago Total: (?:Millas ([\d.]+) \+ )?(CLP|USD) ([\d.,]+)/.exec(t);
  if (!total) fail(mail, "no total");
  const currency = total[2] === "USD" ? "usd" : "clp";
  const amount = currency === "usd" ? latamDollars(total[3]!, mail) : latamPesos(total[3]!, mail);
  const itinerary = /Itinerario de viaje (.+?) (?:Te recomendamos|Lista de pasajeros)/.exec(t)?.[1];
  if (!itinerary || !/^Vuelo de ida /.test(itinerary)) fail(mail, "no itinerary");
  const journeys = itinerary
    .split(/Vuelo de (?:ida|vuelta) /)
    .filter((p) => p.trim() !== "")
    .map((p) => tripJourney(p, mail));
  const passengers = /Lista de pasajeros (.+?) Administrador del viaje/.exec(t)?.[1]?.trim();
  return receipt(mail, "latam", {
    amount,
    currency,
    order_ref: code ?? order,
    concept: concept([
      ...journeys.map(journeyText),
      passengers,
      total[1] ? `+ ${total[1]} millas` : null,
      code ? `orden ${order}` : null,
    ]),
  });
}

function decodeLatamPurchase(mail: ArchivedMail): ProcessorReceipt | null {
  if (!LATAM_PURCHASE_SUBJECT.test(mail.subject)) return null;
  const t = oneLine(mail.text);
  // The reservation before payment: «Monto a pagar Pendiente (Reserva)».
  if (/Pendiente \(Reserva\)/.test(t)) return null;
  if (/^Informaci[oó]n de tu compra$/i.test(mail.subject)) {
    // The purchase is in the attached PDF; the text only greets.
    if (/\$|CLP|Total/.test(t)) fail(mail, "an «Informacion de tu compra» that now states an amount");
    return null;
  }
  if (/(?:Tu código de reserva es|Your reservation code is):/.test(t)) return decodeBoPurchase(mail, t);
  if (/Itinerario de viaje/.test(t)) return decodeTripPurchase(mail, t);
  if (/N[º°] de [Oo]rden/.test(t)) return decodeOrderPurchase(mail, t);
  fail(mail, "no known purchase layout");
}

// ─── Ticket changes ──────────────────────────────────────────────────────────

/** «Ida A. Merino Benítez Intl. a Barajas Intl. 29/8 30/8 22:30:00 …» (2021). */
function changeItinerary(t: string): string[] {
  return [...t.matchAll(/(?:Ida|Vuelta) (.+?) a (.+?) (\d{1,2}\/\d{1,2}) \d{1,2}\/\d{1,2} \d{2}:\d{2}/g)].map(
    (m) => `${m[1]!.trim()} → ${m[2]!.trim()} ${m[3]}`
  );
}

function decodeLatamChange(mail: ArchivedMail): ProcessorReceipt | null {
  if (!LATAM_CHANGE_SUBJECT.test(mail.subject)) return null;
  const t = oneLine(mail.text);
  const total = /Total(?: Pagado)?:? (CLP |USD )?\$ ?([\d.,]+)(?: \((CLP|USD)\))?/.exec(t);
  if (!total) {
    // «Tu cambio se realizó con éxito» (2021) states the new itinerary only: nothing was charged by it.
    if (/Total/.test(t)) fail(mail, "a total this cannot read");
    return null;
  }
  const cur = (total[1]?.trim() ?? total[3] ?? "CLP").toLowerCase();
  const amount = cur === "usd" ? latamDollars(total[2]!, mail) : latamPesos(total[2]!, mail);
  if (amount === 0) return null;
  const ref = /(?:Tu código de reserva es|C[oó]digo de reserva):? ([A-Z0-9]{6})\b/.exec(t)?.[1] ?? /N[º°] de orden:? (LA[0-9A-Z]+)/.exec(t)?.[1] ?? null;
  if (!ref) fail(mail, "no booking code or order number");
  return receipt(mail, "latam_change", {
    amount,
    currency: cur === "usd" ? "usd" : "clp",
    order_ref: ref,
    concept: concept(["Cambio de pasaje", ...changeItinerary(t)]),
  });
}

export const LATAM_PROCESSORS: readonly PaymentProcessor[] = [
  { slug: "latam", gmraw: LATAM_PURCHASE_SENDERS, wantSubject: (s) => LATAM_PURCHASE_SUBJECT.test(s), decode: decodeLatamPurchase },
  { slug: "latam_change", gmraw: LATAM_PURCHASE_SENDERS, wantSubject: (s) => LATAM_CHANGE_SUBJECT.test(s), decode: decodeLatamChange },
];
