/**
 * Despegar (despegar.com, the travel agency) purchase mails → canonical `payment.processor_receipts`
 * receipts.
 *
 * Despegar sells a trip but does not take the whole payment itself: «En el resumen de tu tarjeta
 * recibirás el total desglosado en un cargo correspondiente a LATAM Airlines Group y otros
 * correspondientes a Despegar». The card then shows the provider's charge (the fare and its taxes,
 * «Lanchile (bsp V)») and Despegar's own (its «Cargos», «Despegar Com Tcom») on the same day. The
 * confirmation («¡Genial! Tu viaje está confirmado», noreply@despegar.com, 2019) prints the
 * reservation number, the payment («Tarjeta Master Banco Falabella terminada en NNNN 1 pago de
 * $150.000»), the breakdown («Vuelo para 4 personas $ 130.000 Impuestos y tasas $ 44.128 Cargos
 * $ 7.000 TOTAL $ 150.000») and, for a flight, the itinerary («Ida y vuelta, 2 adultos IDA 3 de
 * febrero LATAM Airlines Group AAA 23:02 … VUELTA 14 de febrero …»).
 *
 * The receipt is the TOTAL, split into the provider's charge (every line of the breakdown but
 * Despegar's own charges) first and Despegar's second when the mail says the payment is split that
 * way; otherwise one charge. The mail prints no purchase time (it is mailed the moment the booking
 * goes through) nor the itinerary's years (the first date on or after the mail's day).
 *
 * The archive's text of the 2019 mail lost its accented letters («recibir�s»), so the patterns
 * accept any character where one stands. Every other Despegar mail (account activation, reviews,
 * check-in, itinerary changes, marketing) decodes to null; a confirmation this cannot read throws.
 */
import type { ProcessorReceipt } from "nw-tracker-contracts";
import type { ArchivedMail } from "../email/santanderMailArchive.js";
import type { PaymentProcessor } from "./paymentReceiptMails.js";

/** Every Despegar sender that has mailed a purchase confirmation. */
const DESPEGAR_SENDER = "noreply@despegar.com";

/** «¡Genial! Tu viaje está confirmado» — and the same for a reservation or a purchase. */
const DESPEGAR_PURCHASE_SUBJECT = /\bTu (?:viaje|reserva|compra) est[aá] confirmad[oa]\b/i;

/** Lines of the breakdown that are Despegar's own charge, not the provider's. */
const DESPEGAR_OWN_LINE = /^(?:Cargos?(?: de (?:servicio|gesti.n))?|Cargo por servicio|Tasa administrativa)$/i;

const MONTHS: Record<string, string> = {
  enero: "01", febrero: "02", marzo: "03", abril: "04", mayo: "05", junio: "06", julio: "07",
  agosto: "08", septiembre: "09", setiembre: "09", octubre: "10", noviembre: "11", diciembre: "12",
};

const CARD_BRANDS: Record<string, string> = {
  master: "Mastercard", mastercard: "Mastercard", visa: "Visa", amex: "American Express",
  "american express": "American Express", diners: "Diners Club",
};

function fail(mail: ArchivedMail, why: string): never {
  throw new Error(`${mail.sent_at_chile} «${mail.subject}»: ${why}`);
}

/** Whole pesos from a Chilean-grouped amount («150.000», «7.000», «700»). */
function pesos(s: string, mail: ArchivedMail): number {
  if (!/^\d{1,3}(?:\.\d{3})*$/.test(s)) fail(mail, `not a peso amount: ${s}`);
  return Number(s.replace(/\./g, ""));
}

/** «3 de febrero» → the first such date on or after `fromYmd`. */
function nextDate(day: string, month: string, fromYmd: string, mail: ArchivedMail): string {
  const mm = MONTHS[month.toLowerCase()];
  if (!mm) fail(mail, `unknown month «${month}»`);
  const mmdd = `${mm}-${day.padStart(2, "0")}`;
  const year = Number(fromYmd.slice(0, 4));
  return mmdd >= fromYmd.slice(5) ? `${year}-${mmdd}` : `${year + 1}-${mmdd}`;
}

/**
 * «Sobre tu vuelo Vuelo Ciudad Norte - Ciudad Sur Ida y vuelta, 2 adultos IDA 3 de febrero
 * LATAM Airlines Group AAA 23:02 … VUELTA 14 de febrero …» → «Vuelo Ciudad Norte ⇄ Ciudad
 * Sur 2026-02-03 → 2026-02-14 · 2 adultos · LATAM Airlines Group».
 */
function flightConcept(t: string, mail: ArchivedMail): string | null {
  const m = /Sobre tu vuelo Vuelo (.+?) - (.+?) (Ida y vuelta|Solo ida|Ida), ((?:\d+ (?:adultos?|ni.os?|menores?|beb.s?),? ?(?:y )?)+) IDA (\d{1,2}) de (\p{L}+) (.+?) [A-Z]{3} \d{2}:\d{2}/u.exec(t);
  if (!m) return null;
  const [, from, to, kind, people, d1, m1, airline] = m as unknown as string[];
  const out = nextDate(d1!, m1!, mail.sent_at_chile.slice(0, 10), mail);
  const roundTrip = /vuelta/i.test(kind!);
  let dates = out;
  if (roundTrip) {
    const back = /VUELTA (\d{1,2}) de (\p{L}+) /u.exec(t);
    if (!back) fail(mail, "a round trip without its VUELTA");
    dates = `${out} → ${nextDate(back[1]!, back[2]!, out, mail)}`;
  }
  const who = people!.trim().replace(/,$/, "");
  return `Vuelo ${from} ${roundTrip ? "⇄" : "→"} ${to} ${dates} · ${who} · ${airline!.trim()}`;
}

/** «Tarjeta Master Banco Falabella terminada en NNNN» → «Mastercard Banco Falabella». */
function paymentMethod(card: string): string {
  const words = card.trim().split(/\s+/);
  const two = words.slice(0, 2).join(" ").toLowerCase();
  if (CARD_BRANDS[two]) return [CARD_BRANDS[two], ...words.slice(2)].join(" ");
  const one = CARD_BRANDS[words[0]!.toLowerCase()];
  return one ? [one, ...words.slice(1)].join(" ") : card.trim();
}

function decodeDespegarPurchase(mail: ArchivedMail): ProcessorReceipt | null {
  if (!DESPEGAR_PURCHASE_SUBJECT.test(mail.subject)) return null;
  const t = mail.text.replace(/\s+/g, " ").trim();
  const ref = /\bN(?:ro|°|º)\.? (?:de )?reserva:? (\d{6,})/i.exec(t)?.[1];
  if (!ref) fail(mail, "no reservation number");

  const pay = /Detalle de pago Tarjeta (.+?) terminada en \d{4} (\d+) (pagos?|cuotas?) de \$ ?([\d.]+)/i.exec(t);
  if (!pay) fail(mail, "no payment («Detalle de pago Tarjeta … terminada en … N pago de $…»)");
  const count = Number(pay[2]);
  const each = pesos(pay[4]!, mail);

  const totalMatch = / TOTAL \$ ?([\d.]+)/.exec(t);
  if (!totalMatch) fail(mail, "no TOTAL");
  const amount = pesos(totalMatch[1]!, mail);
  if (count === 1 ? each !== amount : Math.abs(count * each - amount) > count) {
    fail(mail, `«${count} ${pay[3]} de $${each}» does not make the TOTAL $${amount}`);
  }
  const installments = count > 1 ? count : null;

  // The breakdown sits between the payment and its TOTAL, after the split sentence when there is one.
  const head = t.slice(pay.index + pay[0].length, totalMatch.index);
  const split = /recibir.s el total desglosado en un cargo correspondiente a (.+?) y otros correspondientes a Despegar /i.exec(head);
  const breakdown = split ? head.slice(split.index + split[0].length) : head;
  const lines = [...breakdown.matchAll(/(\S.*?) \$ ?([\d.]+)(?= |$)/g)].map((m) => ({ label: m[1]!.trim(), amount: pesos(m[2]!, mail) }));
  if (lines.length === 0) fail(mail, "no breakdown before the TOTAL");
  const sum = lines.reduce((s, l) => s + l.amount, 0);
  if (sum !== amount) fail(mail, `the breakdown adds up to $${sum}, not the TOTAL $${amount}`);

  let charges: ProcessorReceipt["charges"] = null;
  if (split) {
    const own = lines.filter((l) => DESPEGAR_OWN_LINE.test(l.label)).reduce((s, l) => s + l.amount, 0);
    const provider = amount - own;
    if (own > 0 && provider > 0) {
      if (installments != null) fail(mail, "a payment in cuotas split between Despegar and a provider: which charge is in cuotas is not stated");
      charges = [
        { amount: provider, installments: null },
        { amount: own, installments: null },
      ];
    }
  }

  const bought = /Ya tienes tu (.+?)\. /.exec(t)?.[1];
  const concept = (flightConcept(t, mail) ?? (bought ? `${bought[0]!.toUpperCase()}${bought.slice(1)}` : null))?.slice(0, 300) ?? null;

  return {
    message_id: mail.message_id,
    sent_at_chile: mail.sent_at_chile,
    processor: "despegar",
    payee: { name: "Despegar", rut: null, email: null },
    amount,
    currency: "clp",
    // The mail prints no purchase time; it is mailed the moment the booking goes through.
    paid_at_chile: mail.sent_at_chile,
    order_ref: ref,
    concept,
    statement_descriptor: null,
    payment_method: paymentMethod(pay[1]!),
    installments: charges == null ? installments : null,
    charges,
  };
}

export const DESPEGAR_PROCESSORS: readonly PaymentProcessor[] = [
  { slug: "despegar", from: DESPEGAR_SENDER, wantSubject: (s) => DESPEGAR_PURCHASE_SUBJECT.test(s), decode: decodeDespegarPurchase },
];
