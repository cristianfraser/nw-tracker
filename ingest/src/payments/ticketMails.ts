/**
 * Ticket vendors' purchase mails → canonical `payment.processor_receipts` receipts carrying the
 * event they are for: a card charge «PUNTO TICKET WEB», «TOLIV MARKET», «TICKET MASTER» names the
 * vendor only; the mail names the event, when and where it is, and what was paid.
 *
 * - **PuntoTicket** (`puntoticket`): «Comprobante de Compra - Orden: N». Two layouts: an event's
 *   («Resumen del evento Evento … Lugar … Fecha dd-mm-yyyy Hora hh:mm», one row per item) and an
 *   add-on bought apart (parking: «Item Descripción Precio 001 Estacionamiento …», no event). Items +
 *   despacho must add up to the total. The «Este es su e-Ticket» invitations carry no amount and are
 *   not read; a free order (TOTAL $0) decodes to null.
 * - **Toliv** (`toliv`; tolivmarket.com, toliv.com since 2026-10): «Tus tickets para X» / «Tu
 *   ticket para X». Monto tickets + comisión = Monto total. A free ticket (no «Detalles del pago»)
 *   decodes to null.
 * - **Ticketmaster Chile** (`ticketmaster_cl`): «Tu compra para X se ha realizado con éxito»; the
 *   tickets + «Cargo por servicio» = Total. «Descarga tus entradas» repeats it without amounts and is
 *   not read; a free order («Forma de pago: Sin cargo») decodes to null.
 * - **Ticketmaster New Zealand** (`ticketmaster_nz`): «You're in! Your X ticket confirmation», total
 *   in NZ$ (paired through the dollar statement's original amount).
 * - **Paylogic** (`paylogic`): «Confirmation for X - Order N», total in euros. It mails the same
 *   order again when the tickets change state; the server pairs the first.
 * - **AI Tickets** (`aitickets`): «¡Aquí están tus entradas para X!», «Total pagado».
 * - **Ticketplus** (`ticketplus`): «Tus tickets para X»; the mail states no amount, so it pairs by
 *   the charge's name on its day. The courtesy tickets («Cortesías», invitations) decode to null.
 *
 * Any other mail from these senders decodes to null; a purchase this decoder cannot read throws.
 */
import type { ProcessorReceipt, ReceiptEvent } from "nw-tracker-contracts";
import type { ArchivedMail } from "../email/mailFetcher.js";
import type { PaymentProcessor } from "./paymentReceiptMails.js";

function fail(mail: ArchivedMail, why: string): never {
  throw new Error(`${mail.sent_at_chile} «${mail.subject}» (${mail.message_id}): ${why}`);
}

/** The mail's text as one line, links dropped. */
function flat(mail: ArchivedMail): string {
  return mail.text
    .replace(/\[?https?:\/\/\S+\]?/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function need(text: string, re: RegExp, what: string, mail: ArchivedMail): RegExpMatchArray {
  const m = text.match(re);
  if (!m) fail(mail, `no ${what}`);
  return m;
}

/** Whole pesos from a Chilean-grouped amount («23.000», «$ 4.500»). */
function pesos(s: string, mail: ArchivedMail): number {
  const t = s.replace(/[$\s]/g, "");
  if (!/^\d{1,3}(\.\d{3})*$/.test(t)) fail(mail, `not a peso amount: ${s}`);
  return Number(t.replace(/\./g, ""));
}

/** An amount to the cent with a decimal point («213.59», «1,213.59»). */
function cents(s: string, mail: ArchivedMail): number {
  const t = s.replace(/,/g, "");
  if (!/^\d+\.\d{2}$/.test(t)) fail(mail, `not an amount to the cent: ${s}`);
  return Number(t);
}

const round2 = (n: number) => Math.round(n * 100) / 100;

const MONTHS_ES: Record<string, number> = {
  enero: 1, febrero: 2, marzo: 3, abril: 4, mayo: 5, junio: 6, julio: 7, agosto: 8,
  septiembre: 9, setiembre: 9, octubre: 10, noviembre: 11, diciembre: 12,
};
const MONTHS_EN: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};
const WEEKDAYS_ES = ["domingo", "lunes", "martes", "miercoles", "jueves", "viernes", "sabado"];

const fold = (s: string) => s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();

function iso(y: number, m: number, d: number, mail: ArchivedMail): string {
  const date = new Date(Date.UTC(y, m - 1, d));
  if (date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) fail(mail, `no such date ${y}-${m}-${d}`);
  return date.toISOString().slice(0, 10);
}

function monthEs(name: string, mail: ArchivedMail): number {
  const m = MONTHS_ES[fold(name)];
  if (!m) fail(mail, `unknown month «${name}»`);
  return m;
}

/**
 * A date printed without its year («Jueves 26 de Octubre», «Lunes 01 Enero»): the first such day on
 * or after the mail's day, a year at most later; its printed weekday must agree.
 */
function dateAfterMail(day: number, month: number, weekday: string | null, mail: ArchivedMail): string {
  const sent = mail.sent_at_chile.slice(0, 10);
  const y0 = Number(sent.slice(0, 4));
  const candidate = [y0, y0 + 1].map((y) => iso(y, month, day, mail)).find((d) => d >= sent);
  if (!candidate) fail(mail, `no ${day}/${month} after the mail`);
  if (weekday != null) {
    const want = WEEKDAYS_ES.indexOf(fold(weekday));
    if (want < 0) fail(mail, `unknown weekday «${weekday}»`);
    if (new Date(`${candidate}T00:00:00Z`).getUTCDay() !== want) fail(mail, `${candidate} is not a ${weekday}`);
  }
  return candidate;
}

function receipt(
  mail: ArchivedMail,
  processor: string,
  vendor: string,
  fields: Pick<ProcessorReceipt, "amount" | "currency" | "paid_at_chile" | "order_ref" | "concept" | "payment_method"> & {
    event: ReceiptEvent | null;
  }
): ProcessorReceipt {
  return {
    message_id: mail.message_id,
    sent_at_chile: mail.sent_at_chile,
    processor,
    payee: { name: vendor, rut: null, email: null },
    statement_descriptor: null,
    installments: null,
    charges: null,
    ...fields,
    concept: fields.concept ? fields.concept.slice(0, 300) : null,
  };
}

// ─── PuntoTicket ─────────────────────────────────────────────────────────────

const PUNTOTICKET_SUBJECT = /^Comprobante de Compra - Orden:? ?(\d+)/i;

function decodePuntoTicket(mail: ArchivedMail): ProcessorReceipt | null {
  const subject = mail.subject.match(PUNTOTICKET_SUBJECT);
  if (!subject) return null;
  const t = flat(mail);
  const total = pesos(need(t, /(?<![-\p{L}])(?:TOTAL|Total):? \$ ?([\d.]+)/u, "total", mail)[1]!, mail);
  if (total === 0) return null;
  const subtotal = pesos(need(t, /\bSUB-?TOTAL:? \$ ?([\d.]+)/i, "subtotal", mail)[1]!, mail);
  const delivery = pesos(need(t, /\b(?:DESPACHO|Despacho o Retiro):? \$ ?([\d.]+)/, "despacho", mail)[1]!, mail);
  if (subtotal + delivery !== total) fail(mail, `subtotal ${subtotal} + despacho ${delivery} ≠ total ${total}`);
  const when = t.match(/\bFecha:? (\d{2})-(\d{2})-(\d{4})(?: Hora:? (\d{2}:\d{2}))?/);
  if (!when) fail(mail, "no purchase date");
  const paidAt = `${when[3]}-${when[2]}-${when[1]} ${when[4] ?? mail.sent_at_chile.slice(11)}`;
  // Items: «1 GENERAL $23.000 2 ESTACIONAMIENTO $8.000» / «001 Estacionamiento Viernes $ 5.000».
  const table = need(t, /\b(?:Ubicaci[oó]n|Descripci[oó]n) Precio (.+?) SUB-?TOTAL/i, "items", mail)[1]!;
  const items = [...table.matchAll(/(?:^| )\d{1,3} (.+?) \$ ?([\d.]+)/g)].map((m) => ({ what: m[1]!.trim(), price: pesos(m[2]!, mail) }));
  if (items.length === 0) fail(mail, "no item rows");
  const sum = items.reduce((s, i) => s + i.price, 0);
  if (sum !== subtotal) fail(mail, `items ${sum} ≠ subtotal ${subtotal}`);
  const counted = new Map<string, number>();
  for (const i of items) counted.set(i.what, (counted.get(i.what) ?? 0) + 1);
  const concept = [...counted].map(([what, n]) => (n > 1 ? `${n} × ${what}` : what)).join(" · ");
  let event: ReceiptEvent | null = null;
  if (/Resumen del evento/.test(t)) {
    const e = need(t, /Resumen del evento Evento:? (.+?) Lugar:? (.+?) Fecha:? (\d{2})-(\d{2})-(\d{4}) Hora:? (\d{2}:\d{2})/, "event", mail);
    event = { name: e[1]!.trim(), starts_on: `${e[5]}-${e[4]}-${e[3]}`, starts_at: e[6]!, ends_on: null, venue: e[2]!.trim() };
  }
  return receipt(mail, "puntoticket", "PuntoTicket", {
    amount: total,
    currency: "clp",
    paid_at_chile: paidAt,
    order_ref: subject[1]!,
    concept,
    payment_method: null,
    event,
  });
}

// ─── Toliv ───────────────────────────────────────────────────────────────────

const TOLIV_SUBJECT = /^Tus? tickets? para (.+)$/i;
/** «31 de Enero 2025 23:00hrs», «1 de Febrero 2025 01:40:09hrs». */
const TOLIV_DATE = String.raw`(\d{1,2}) de (\p{L}+) (\d{4}) (\d{2}:\d{2})(?::\d{2})?\s?hrs`;

function decodeToliv(mail: ArchivedMail): ProcessorReceipt | null {
  const subject = mail.subject.match(TOLIV_SUBJECT);
  if (!subject) return null;
  const t = flat(mail);
  if (!/Detalles del pago/.test(t)) {
    // A ticket given for free (a guest list) has no payment block.
    if (/Monto (?:total|tickets)/i.test(t)) fail(mail, "an amount without the payment block");
    return null;
  }
  const amounts = need(t, /Monto tickets:? \$([\d.]+) CLP Monto comisi[oó]n:? \$([\d.]+) CLP Monto total:? \$([\d.]+) CLP/, "amounts", mail);
  const [tickets, fee, total] = [1, 2, 3].map((i) => pesos(amounts[i]!, mail)) as [number, number, number];
  if (tickets + fee !== total) fail(mail, `tickets ${tickets} + comisión ${fee} ≠ total ${total}`);
  if (total === 0) return null;
  const paid = need(t, new RegExp(`Fecha de pago:? ${TOLIV_DATE}`, "u"), "payment date", mail);
  const starts = need(t, new RegExp(`Fecha:? ${TOLIV_DATE}`, "u"), "event date", mail);
  const name = (t.match(/Nombre:? (.+?) Fecha:/)?.[1] ?? subject[1]!).trim();
  const place = t.match(/Lugar:? (.+?) Detalles del pago/)?.[1]?.trim();
  const address = t.match(/Direcci[oó]n:? (.+?) (?:Lugar:|Una vez|Detalles del pago)/)?.[1]?.replace(/\s+,/g, ",").trim();
  // «# , Santiago»: the organizer left the address blank.
  const venue = place || (address && /\p{L}{3}.*\d|\d.*\p{L}{3}/u.test(address.replace(/,\s*\p{L}+$/u, "")) ? address : null);
  const ticketCount = t.match(/Tickets totales:? (\d+)/)?.[1];
  const method = t.match(/Medio de pago:? (\S+)/)?.[1] ?? null;
  return receipt(mail, "toliv", "Toliv", {
    amount: total,
    currency: "clp",
    paid_at_chile: `${iso(Number(paid[3]), monthEs(paid[2]!, mail), Number(paid[1]), mail)} ${paid[4]}`,
    order_ref: t.match(/Ticket:? #(\d+)/)?.[1] ?? null,
    concept: [name, ticketCount && Number(ticketCount) > 1 ? `${ticketCount} tickets` : null].filter(Boolean).join(" · "),
    payment_method: method,
    event: {
      name,
      starts_on: iso(Number(starts[3]), monthEs(starts[2]!, mail), Number(starts[1]), mail),
      starts_at: starts[4]!,
      ends_on: null,
      venue: venue ?? null,
    },
  });
}

// ─── Ticketmaster ────────────────────────────────────────────────────────────

const TICKETMASTER_CL_SUBJECT = /^Tu compra para (.+) se ha realizado con [eé]xito$/i;

function decodeTicketmasterCl(mail: ArchivedMail): ProcessorReceipt | null {
  const subject = mail.subject.match(TICKETMASTER_CL_SUBJECT);
  if (!subject) return null;
  const t = flat(mail);
  const total = pesos(need(t, /\bTotal \$ ?([\d.]+)/, "total", mail)[1]!, mail);
  if (total === 0 || /Forma de pago:? Sin cargo/i.test(t)) return null;
  const name = subject[1]!.trim();
  const summary = need(t, /Orden #(\d+) (.+?) Otros costos (.+?) Total \$/, "order summary", mail);
  // «Jueves 26 de Octubre General - Preventa $ 30.000» / «22/01/2025 20:00 General - … $ 0».
  const body = summary[2]!;
  let startsOn: string;
  let startsAt: string | null = null;
  let rows: string;
  const numeric = body.match(/^(\d{2})\/(\d{2})\/(\d{4})(?: (\d{2}:\d{2}))? (.+)$/);
  const named = body.match(/^(\p{L}+) (\d{1,2}) de (\p{L}+)(?: (\d{4}))?(?: (\d{2}:\d{2}))? (.+)$/u);
  if (numeric) {
    startsOn = iso(Number(numeric[3]), Number(numeric[2]), Number(numeric[1]), mail);
    startsAt = numeric[4] ?? null;
    rows = numeric[5]!;
  } else if (named) {
    const month = monthEs(named[3]!, mail);
    startsOn = named[4] ? iso(Number(named[4]), month, Number(named[2]), mail) : dateAfterMail(Number(named[2]), month, named[1]!, mail);
    startsAt = named[5] ?? null;
    rows = named[6]!;
  } else {
    fail(mail, `no event date in «${body}»`);
  }
  const tickets = [...rows.matchAll(/(.+?) \$ ?([\d.]+)(?: |$)/g)].map((m) => ({ what: m[1]!.trim(), price: pesos(m[2]!, mail) }));
  const costs = [...summary[3]!.matchAll(/(.+?) \$ ?([\d.]+)(?: |$)/g)].map((m) => pesos(m[2]!, mail));
  const sum = [...tickets.map((x) => x.price), ...costs].reduce((s, n) => s + n, 0);
  if (tickets.length === 0 || sum !== total) fail(mail, `tickets and costs ${sum} ≠ total ${total}`);
  const counted = new Map<string, number>();
  for (const x of tickets) counted.set(x.what, (counted.get(x.what) ?? 0) + 1);
  // «Nico Moreno - Basel Venue Esta es la confirmación…»: the venue follows the event's name.
  const venue = t.match(new RegExp(`${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} - (.+?) Esta es la confirmaci`))?.[1]?.trim() ?? null;
  return receipt(mail, "ticketmaster_cl", "Ticketmaster", {
    amount: total,
    currency: "clp",
    paid_at_chile: mail.sent_at_chile,
    order_ref: summary[1]!,
    concept: [name, ...[...counted].map(([what, n]) => (n > 1 ? `${n} × ${what}` : what))].join(" · "),
    payment_method: t.match(/Forma de pago:? (\S+)/)?.[1] ?? null,
    event: { name, starts_on: startsOn, starts_at: startsAt, ends_on: null, venue },
  });
}

const TICKETMASTER_NZ_SUBJECT = /^You.re in! Your (.+) ticket confirmation$/i;

function decodeTicketmasterNz(mail: ArchivedMail): ProcessorReceipt | null {
  const subject = mail.subject.match(TICKETMASTER_NZ_SUBJECT);
  if (!subject) return null;
  const t = flat(mail);
  const total = cents(need(t, /\bTotal NZ ?\$ ?([\d,]+\.\d{2})/, "total in NZ$", mail)[1]!, mail);
  const name = subject[1]!.trim();
  // «Order #34-22035/NZL Eden The Powerstation, Auckland Sat 25 Nov 2023 @ 8:00 pm Your Order»
  const head = need(
    t,
    /Order #(\S+) (.+?) (?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)\w* (\d{1,2}) (\p{L}{3})\p{L}* (\d{4}) @ (\d{1,2}):(\d{2}) ?([ap]m)/iu,
    "order and date",
    mail
  );
  const month = MONTHS_EN[head[4]!.toLowerCase()];
  if (!month) fail(mail, `unknown month «${head[4]}»`);
  const hour = (Number(head[6]) % 12) + (head[8]!.toLowerCase() === "pm" ? 12 : 0);
  const rest = head[2]!.trim();
  const venue = rest.startsWith(`${name} `) ? rest.slice(name.length).trim() : null;
  const items = t.match(/Your Order (\d+)x/)?.[1];
  return receipt(mail, "ticketmaster_nz", "Ticketmaster", {
    amount: total,
    currency: "nzd",
    paid_at_chile: mail.sent_at_chile,
    order_ref: head[1]!,
    concept: [name, items && Number(items) > 1 ? `${items} tickets` : null].filter(Boolean).join(" · "),
    payment_method: null,
    event: {
      name,
      starts_on: iso(Number(head[5]), month, Number(head[3]), mail),
      starts_at: `${String(hour).padStart(2, "0")}:${head[7]}`,
      ends_on: null,
      venue,
    },
  });
}

// ─── Paylogic ────────────────────────────────────────────────────────────────

const PAYLOGIC_SUBJECT = /^Confirmation for (.+) - Order (\d+)/i;

function decodePaylogic(mail: ArchivedMail): ProcessorReceipt | null {
  const subject = mail.subject.match(PAYLOGIC_SUBJECT);
  if (!subject) return null;
  const t = flat(mail);
  const total = need(t, /\bTotal € ([\d,]+\.\d{2}) EUR\b/, "total in euros", mail);
  const subtotal = cents(need(t, /\bSubtotal € ([\d,]+\.\d{2}) EUR\b/, "subtotal", mail)[1]!, mail);
  const fee = cents(t.match(/\bService fee € ([\d,]+\.\d{2}) EUR\b/)?.[1] ?? "0.00", mail);
  const amount = cents(total[1]!, mail);
  if (round2(subtotal + fee) !== amount) fail(mail, `subtotal ${subtotal} + fee ${fee} ≠ total ${amount}`);
  const name = subject[1]!.trim();
  const when = need(
    t,
    /(\p{L}{3}) (\d{1,2}), (\d{4})(?: - (\p{L}{3}) (\d{1,2}), (\d{4}))? (.+?) (?:Adding information|Your tickets|Download E-Ticket|Manage order|This email)/u,
    "event dates",
    mail
  );
  const month = (abbr: string) => MONTHS_EN[abbr.toLowerCase()] ?? fail(mail, `unknown month «${abbr}»`);
  const items = need(t, /Subtotal \(incl\. VAT\) (.+?) Subtotal €/, "items", mail)[1]!;
  const lines = [...items.matchAll(/(.+?) (\d+) € ([\d,]+\.\d{2}) EUR/g)].map((m) => `${m[2] !== "1" ? `${m[2]} × ` : ""}${m[1]!.trim()}`);
  return receipt(mail, "paylogic", "Paylogic", {
    amount,
    currency: "eur",
    // The confirmation is mailed when the payment clears; it prints no time of its own.
    paid_at_chile: mail.sent_at_chile,
    order_ref: subject[2]!,
    concept: [name, ...lines].join(" · "),
    payment_method: t.match(/Payment method (\S+)/)?.[1] ?? null,
    event: {
      name,
      starts_on: iso(Number(when[3]), month(when[1]!), Number(when[2]), mail),
      starts_at: null,
      ends_on: when[4] ? iso(Number(when[6]), month(when[4]), Number(when[5]), mail) : null,
      venue: when[7]!.trim(),
    },
  });
}

// ─── AI Tickets ──────────────────────────────────────────────────────────────

const AITICKETS_SUBJECT = /tus entradas para (.+?)!?$/i;
/** «viernes, 10 de octubre de 2025 a las 22:00 hrs», «martes, 7 de octubre de 2025, 20:52». */
const AITICKETS_DATE = String.raw`\p{L}+, (\d{1,2}) de (\p{L}+) de (\d{4})(?:,| a las) (\d{2}:\d{2})`;

function decodeAiTickets(mail: ArchivedMail): ProcessorReceipt | null {
  if (!AITICKETS_SUBJECT.test(mail.subject)) return null;
  const t = flat(mail);
  const total = pesos(need(t, /Total pagado:? \$([\d.]+)/, "total", mail)[1]!, mail);
  if (total === 0) return null;
  const e = need(t, new RegExp(`Evento: (.+?) Fecha: ${AITICKETS_DATE} hrs Lugar: (.+?) Detalles de tu Orden`, "u"), "event", mail);
  const bought = need(t, new RegExp(`Fecha de compra:? ${AITICKETS_DATE}`, "u"), "purchase date", mail);
  const rows = t.match(/Tipo de entrada Cantidad Precio unitario Total (.+?) Total pagado/)?.[1] ?? "";
  const lines = [...rows.matchAll(/(.+?) (\d+) \$[\d.]+ \$([\d.]+)/g)];
  if (lines.reduce((s, m) => s + pesos(m[3]!, mail), 0) !== total) fail(mail, `ticket rows ≠ total ${total}`);
  const name = e[1]!.trim();
  return receipt(mail, "aitickets", "AI Tickets", {
    amount: total,
    currency: "clp",
    paid_at_chile: `${iso(Number(bought[3]), monthEs(bought[2]!, mail), Number(bought[1]), mail)} ${bought[4]}`,
    order_ref: t.match(/N[°º] Orden:? ([0-9a-f-]{8,})/i)?.[1] ?? null,
    concept: [name, ...lines.map((m) => `${m[2] !== "1" ? `${m[2]} × ` : ""}${m[1]!.trim()}`)].join(" · "),
    payment_method: null,
    event: {
      name,
      starts_on: iso(Number(e[4]), monthEs(e[3]!, mail), Number(e[2]), mail),
      starts_at: e[5]!,
      ends_on: null,
      venue: e[6]!.trim(),
    },
  });
}

// ─── Ticketplus ──────────────────────────────────────────────────────────────

const TICKETPLUS_SUBJECT = /^Tus (?:tickets|entradas) para (.+)$/i;

function decodeTicketplus(mail: ArchivedMail): ProcessorReceipt | null {
  const subject = mail.subject.match(TICKETPLUS_SUBJECT);
  if (!subject) return null;
  const t = flat(mail);
  // Courtesy tickets an organizer sends: nothing was paid.
  if (/Cortes[ií]as|Invitad[oae]s|Invitaci[oó]n/i.test(`${mail.subject} ${t.slice(0, 200)}`)) return null;
  const name = subject[1]!.replace(/^[^\p{L}\p{N}"]+|[^\p{L}\p{N}"]+$/gu, "").trim();
  // «Lunes 01 Enero Ex Fábrica, Asunción 426 Puedes acceder…»
  const when = need(
    t,
    /tus (?:tickets|entradas) para:? .+? (Lunes|Martes|Mi[eé]rcoles|Jueves|Viernes|S[aá]bado|Domingo) (\d{1,2})(?: de)? (\p{L}+) (.+?) Puedes acceder/iu,
    "event date",
    mail
  );
  return receipt(mail, "ticketplus", "Ticketplus", {
    amount: null,
    currency: "clp",
    paid_at_chile: mail.sent_at_chile,
    order_ref: null,
    concept: name,
    payment_method: null,
    event: {
      name,
      starts_on: dateAfterMail(Number(when[2]), monthEs(when[3]!, mail), when[1]!, mail),
      starts_at: null,
      ends_on: null,
      venue: when[4]!.trim(),
    },
  });
}

export const TICKET_PROCESSORS: readonly PaymentProcessor[] = [
  { slug: "puntoticket", from: "confirmaciones@puntoticket.cl", wantSubject: (s) => PUNTOTICKET_SUBJECT.test(s), decode: decodePuntoTicket },
  {
    slug: "toliv",
    gmraw: "from:(no-reply@tolivmarket.com OR no-reply@toliv.com)",
    wantSubject: (s) => TOLIV_SUBJECT.test(s),
    decode: decodeToliv,
  },
  { slug: "ticketmaster_cl", from: "noreply@ticketmaster.cl", wantSubject: (s) => TICKETMASTER_CL_SUBJECT.test(s), decode: decodeTicketmasterCl },
  { slug: "ticketmaster_nz", from: "ticketmaster.co.nz", wantSubject: (s) => TICKETMASTER_NZ_SUBJECT.test(s), decode: decodeTicketmasterNz },
  { slug: "paylogic", from: "no-reply@paylogic.com", wantSubject: (s) => PAYLOGIC_SUBJECT.test(s), decode: decodePaylogic },
  { slug: "aitickets", from: "aitickets.cl", wantSubject: (s) => AITICKETS_SUBJECT.test(s), decode: decodeAiTickets },
  { slug: "ticketplus", from: "info@ticketplus.cl", wantSubject: (s) => TICKETPLUS_SUBJECT.test(s), decode: decodeTicketplus },
];
