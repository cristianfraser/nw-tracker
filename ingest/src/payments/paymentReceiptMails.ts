/**
 * Payment processors' receipts and shops' order confirmations → canonical
 * `payment.processor_receipts` receipts.
 *
 * A card or checking line names the processor, not the shop («PAGOS.FLOW.CL (WEB)», «PAGO FACIL»,
 * «MERCADOPAGO*…»); the processor's receipt, or the shop's own order confirmation, names who was
 * paid, for what, the amount and the time. One decoder per sender (or, for a shop platform many
 * shops mail from, per layout); a mail that is not a receipt (an invoice still to pay, a
 * subscription sign-up) decodes to null, and a receipt this decoder cannot read throws.
 */
import type { ProcessorReceipt } from "nw-tracker-contracts";
import type { ArchivedMail } from "../email/santanderMailArchive.js";

export type PaymentProcessor = {
  slug: string;
  /** IMAP FROM match… */
  from?: string;
  /** …or a Gmail search query (a platform many shops mail from). */
  gmraw?: string;
  /** The subjects that may be a receipt (envelope filter). */
  wantSubject: (subject: string) => boolean;
  decode: (mail: ArchivedMail) => ProcessorReceipt | null;
};

/** A match the receipt must have; reading a group it did not capture throws. */
function need(text: string, re: RegExp, what: string, mail: ArchivedMail): (group: number) => string {
  const m = text.match(re);
  if (!m) throw new Error(`${mail.sent_at_chile} «${mail.subject}»: no ${what}`);
  return (group) => {
    const g = m[group];
    if (g == null) throw new Error(`${mail.sent_at_chile} «${mail.subject}»: ${what} without group ${group}`);
    return g;
  };
}

/** Whole pesos from a Chilean-grouped amount («125.716»). */
function chileanPesos(s: string): number {
  if (!/^\d{1,3}(\.\d{3})*$/.test(s)) throw new Error(`not a peso amount: ${s}`);
  return Number(s.replace(/\./g, ""));
}

const FLOW_RECEIPT_SUBJECT = /^Aviso de pago realizado\b/i;

function decodeFlow(mail: ArchivedMail): ProcessorReceipt | null {
  if (!FLOW_RECEIPT_SUBJECT.test(mail.subject)) return null;
  const t = mail.text;
  const payee = need(t, /pago realizado a (.+?) por medio de nuestra plataforma/i, "payee", mail)(1).trim();
  const order = need(t, /N[º°] Orden:? (\d+)/, "order", mail)(1);
  const at = need(t, /Fecha y hora:? (\d{2})-(\d{2})-(\d{4}) (\d{2}:\d{2})/, "date", mail);
  const amount = need(t, /Monto:? ([\d.]+) (CLP|[A-Z]{3})\b/, "amount", mail);
  if (amount(2) !== "CLP") throw new Error(`${mail.sent_at_chile} «${mail.subject}»: amount in ${amount(2)}`);
  const concept = t.match(/Concepto:? (.+?) (?:N[º°] Orden del comercio|El cargo en (?:su|tu) cartola)/)?.[1]?.trim() || null;
  const descriptor = t.match(/El cargo en (?:su|tu) cartola dir[aá] (.+?) Importante/)?.[1]?.trim() || null;
  const method = t.match(/Medio de pago:? (.+?) (?:Información|RUT|Concepto)/)?.[1]?.trim() || null;
  const rut = t.match(/RUT (\d[\d.]*-[\dkK])\b/)?.[1] || null;
  const email = t.match(/al email (\S+@\S+?\.[a-z]{2,})(?: |$)/i)?.[1] || null;
  return {
    message_id: mail.message_id,
    sent_at_chile: mail.sent_at_chile,
    processor: "flow",
    payee: { name: payee, rut, email },
    amount: chileanPesos(amount(1)),
    currency: "clp",
    paid_at_chile: `${at(3)}-${at(2)}-${at(1)} ${at(4)}`,
    order_ref: order,
    concept,
    statement_descriptor: descriptor,
    payment_method: method,
    installments: null,
  };
}

const PAGO_FACIL_RECEIPT_SUBJECT = /^Tu comprobante de pedido #\d+/i;

function decodePagoFacil(mail: ArchivedMail): ProcessorReceipt | null {
  if (!PAGO_FACIL_RECEIPT_SUBJECT.test(mail.subject)) return null;
  const t = mail.text;
  const head = need(t, /El pago por el pedido #(\d+) en (.+?) ha sido procesado/, "payee", mail);
  const amount = need(t, /Monto Total \$(\d+)\.00\b/, "whole-peso amount", mail);
  const cuotas = t.match(/Cuotas (\d+)/)?.[1];
  const method = t.match(/M[ée]todo de pago (\S+)/)?.[1] || null;
  return {
    message_id: mail.message_id,
    sent_at_chile: mail.sent_at_chile,
    processor: "pago_facil",
    payee: { name: head(2).trim(), rut: null, email: null },
    amount: Number(amount(1)),
    currency: "clp",
    // The receipt prints no time: it is mailed the moment the payment clears.
    paid_at_chile: mail.sent_at_chile,
    order_ref: head(1),
    concept: null,
    statement_descriptor: null,
    payment_method: method,
    installments: cuotas != null && Number(cuotas) > 1 ? Number(cuotas) : null,
  };
}

const SHOPIFY_ORDER_SUBJECT = /^(?:\[[^\]]+\]\s*)?Confirmaci[oó]n de pedido\b/i;

/**
 * A Shopify shop's «Confirmación de pedido» (the layout every Shopify store mails, from its own
 * domain or from t.shopifyemail.com): the shop, the items and the total in pesos.
 */
function decodeShopifyOrder(mail: ArchivedMail): ProcessorReceipt | null {
  if (!SHOPIFY_ORDER_SUBJECT.test(mail.subject) || !/Resumen del pedido/.test(mail.text)) return null;
  const t = mail.text;
  const ref = need(t, /Pedido (#?[A-Za-z]*\d+)/, "order number", mail)(1);
  const total = need(t, /\bTotal \$([\d.]+) CLP\b/, "total in CLP", mail)(1);
  // The shop: the subject's bracket, else what the mail prints before «Pedido #…», else the
  // sender's display name.
  const bracket = mail.subject.match(/^\[([^\]]+)\]/)?.[1];
  const before = t
    .slice(0, t.indexOf(`Pedido ${ref}`))
    .replace(/\S*Gracias por tu compra!/g, "")
    .trim();
  const shop = (bracket ?? (before || mail.from_name || ""))
    .replace(/[^\p{L}\p{N}\s.&'-]/gu, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!shop) throw new Error(`${mail.sent_at_chile} «${mail.subject}»: no shop name`);
  const summary = need(t, /Resumen del pedido (.+?) Subtotal /, "order summary", mail)(1);
  const items = summary
    .replace(/\((?:-?\$[\d.]+(?: CLP)?)\)/g, " ")
    .split(/-?\$-?[\d.]+(?: CLP)?/)
    .map((x) => x.replace(/Default Title/g, "").replace(/\s+/g, " ").trim())
    .filter((x) => x && !/^(Descuento|Gratis|PROMO)\b/i.test(x));
  const method = t.match(/(?:M[ée]todo de pago|\bPago) (.+?)(?: \$[\d.]+| M[ée]todo de env[ií]o| Si tienes| Este email|$)/)?.[1]?.trim() || null;
  return {
    message_id: mail.message_id,
    sent_at_chile: mail.sent_at_chile,
    processor: "shopify",
    payee: { name: shop, rut: null, email: null },
    amount: chileanPesos(total),
    currency: "clp",
    paid_at_chile: mail.sent_at_chile,
    order_ref: ref,
    concept: items.length > 0 ? items.join(" · ").slice(0, 300) : null,
    statement_descriptor: null,
    payment_method: method,
    installments: null,
  };
}

export const PAYMENT_PROCESSORS: readonly PaymentProcessor[] = [
  { slug: "flow", from: "flow.cl", wantSubject: (s) => /flow/i.test(s), decode: decodeFlow },
  { slug: "pago_facil", from: "pagofacil.cl", wantSubject: (s) => PAGO_FACIL_RECEIPT_SUBJECT.test(s), decode: decodePagoFacil },
  {
    slug: "shopify",
    gmraw: '"Confirmación de pedido" "Resumen del pedido"',
    wantSubject: (s) => SHOPIFY_ORDER_SUBJECT.test(s),
    decode: decodeShopifyOrder,
  },
];

export function decodePaymentReceiptMail(processor: PaymentProcessor, mail: ArchivedMail): ProcessorReceipt | null {
  return processor.decode(mail);
}
