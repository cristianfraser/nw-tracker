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


/**
 * Whole pesos from an amount as a shop prints it: Chilean-grouped («23.135»), ungrouped («23135»)
 * or with zero centavos («23.135,00»). Any other decimals throw.
 */
function printedPesos(s: string): number {
  const m = s.match(/^(\d+|\d{1,3}(?:\.\d{3})+)(?:,(\d+))?$/);
  if (!m) throw new Error(`not a peso amount: ${s}`);
  if (m[2] != null && !/^0+$/.test(m[2])) throw new Error(`peso amount with centavos: ${s}`);
  return Number(m[1]!.replace(/\./g, ""));
}

function fail(mail: ArchivedMail, why: string): never {
  throw new Error(`${mail.sent_at_chile} «${mail.subject}»: ${why}`);
}

function concept(items: string[]): string | null {
  return items.length > 0 ? items.join(" · ").slice(0, 300) : null;
}

// ─── Shops that mail their own order confirmation ────────────────────────────

const CALVIN_KLEIN_ORDER_SUBJECT = /^Tu pedido ha sido realizado exitosamente\b/i;

/**
 * Calvin Klein's «Tu pedido ha sido realizado exitosamente.»: items at the price paid, then
 * Subtotal, an optional Descuento and Total, which the payment block repeats as «Valor».
 */
function decodeCalvinKlein(mail: ArchivedMail): ProcessorReceipt | null {
  if (!CALVIN_KLEIN_ORDER_SUBJECT.test(mail.subject)) return null;
  const t = mail.text;
  const ref = need(t, /Tu pedido (\S+) fue confirmado/, "order number", mail)(1);
  const total = printedPesos(need(t, /\bTotal: \$ ([\d.,]+)/, "total", mail)(1));
  const valor = t.match(/\bValor: \$ ([\d.,]+)/)?.[1];
  if (valor != null && printedPesos(valor) !== total) {
    throw new Error(`${mail.sent_at_chile} «${mail.subject}»: Total ${total} ≠ Valor ${valor}`);
  }
  const summary = need(t, /Resumen del Pedido (.+?) Subtotal:/, "order summary", mail)(1);
  const items = summary
    .split(/ Ver producto \$ [\d.,]+/)
    .map((x) => x.trim())
    .filter(Boolean)
    .map((x) => {
      // «Name TALLA:L Cant. 1 TALLA:L» → «Name × 1 L»
      const m = x.match(/^(.+?) TALLA:(\S+) Cant\. (\d+)/);
      return m ? `${m[1]} × ${m[3]} ${m[2]}` : x;
    });
  return {
    message_id: mail.message_id,
    sent_at_chile: mail.sent_at_chile,
    processor: "calvin_klein",
    payee: { name: "Calvin Klein", rut: null, email: null },
    amount: total,
    currency: "clp",
    paid_at_chile: mail.sent_at_chile,
    order_ref: ref,
    concept: concept(items),
    statement_descriptor: null,
    payment_method: t.match(/M[ée]todo de Pago (.+?) Valor:/i)?.[1]?.trim() || null,
    installments: null,
  };
}

const ADIDAS_ORDER_SUBJECT = /hemos recibido tu pedido|^Gracias por tu pedido\b/i;

/**
 * adidas's order confirmation, two layouts: «…, hemos recibido tu pedido» (to 2023: Productos −
 * Código Promocional + Entrega − Envío Descuento = Total; the Tax line is included in it) and
 * «Gracias por tu pedido, …» (2025 on: every block printed twice, Artículos + Envío = Total).
 * The shipping and delivery mails decode to null.
 */
function decodeAdidas(mail: ArchivedMail): ProcessorReceipt | null {
  if (!ADIDAS_ORDER_SUBJECT.test(mail.subject)) return null;
  const t = mail.text;
  const ref = need(t, /(?:N[úu]mero de orden|N[úu]mero de pedido):? (ACL\d+)/, "order number", mail)(1);
  const total = printedPesos(need(t, /\bTotal \$ ?([\d.,]+) \(impuestos incluidos\)/, "total", mail)(1));
  let items: string[];
  let method: string | null;
  // The item list follows the last «TU PEDIDO» (the heading «HEMOS RECIBIDO TU PEDIDO» comes first).
  const oldList = t.match(/\bTU PEDIDO ((?:(?!TU PEDIDO).)+?) HABLA CON NOSOTROS/)?.[1];
  if (oldList != null) {
    const list = oldList;
    // «Name $sale [$list] Color: … Talla: … Cantidad: N Artículo N°: XX»
    items = [...list.matchAll(/(.+?) \$[\d.]+(?: \$[\d.]+)? Color: .+? Cantidad: (\d+) Art[ií]culo N[°º]: \S+/g)].map(
      (m) => `${m[1]!.trim()} × ${m[2]}`
    );
    method = t.match(/Datos De Facturaci[oó]n .+? Via: (.+?) Resumen Del Pedido/)?.[1]?.trim() || null;
  } else {
    // «Name $price Talla: X / Cantidad: N Color: …», each item once per rendering.
    const seen = new Set<string>();
    items = [];
    for (const m of t.matchAll(/(?:Entregado|Consultar pedido) ((?:(?!Entregado |Consultar pedido ).)+?) \$[\d.]+ Talla: (.+?) \/ Cantidad: (\d+)/g)) {
      const item = `${m[1]!.trim()} × ${m[3]} ${m[2]!.trim()}`;
      if (!seen.has(item)) {
        seen.add(item);
        items.push(item);
      }
    }
    method = t.match(/Forma de pago (?:Forma de pago )?(.+?) Total\b/)?.[1]?.trim() || null;
  }
  return {
    message_id: mail.message_id,
    sent_at_chile: mail.sent_at_chile,
    processor: "adidas",
    payee: { name: "adidas", rut: null, email: null },
    amount: total,
    currency: "clp",
    paid_at_chile: mail.sent_at_chile,
    order_ref: ref,
    concept: concept(items),
    statement_descriptor: null,
    payment_method: method,
    installments: null,
  };
}

const CLUB_DOMINO_ORDER_SUBJECT = /Pedido Confirmado/i;
const SPANISH_MONTHS: Record<string, string> = {
  ene: "01", feb: "02", mar: "03", abr: "04", may: "05", jun: "06",
  jul: "07", ago: "08", sep: "09", sept: "09", oct: "10", nov: "11", dic: "12",
};

/**
 * Club Dominó's «¡Pedido Confirmado!»: comprobante, branch, the order's own time, items, then
 * Subtotal, Propina, Descuento and Total (what the card paid, tip included) and the card.
 */
function decodeClubDomino(mail: ArchivedMail): ProcessorReceipt | null {
  if (!CLUB_DOMINO_ORDER_SUBJECT.test(mail.subject)) return null;
  const t = mail.text;
  const head = need(
    t,
    /Comprobante # (\S+) (.+?) [a-záéíóú]{3}\.?, (\d{1,2}) ([a-z]{3,4})\.? (\d{4}) en (\d{1,2}):(\d{2})/i,
    "comprobante and time",
    mail
  );
  const month = SPANISH_MONTHS[head(4).toLowerCase()];
  if (!month) throw new Error(`${mail.sent_at_chile} «${mail.subject}»: unknown month ${head(4)}`);
  const paidAt = `${head(5)}-${month}-${head(3).padStart(2, "0")} ${head(6).padStart(2, "0")}:${head(7)}`;
  const totalM = need(t, /\bTotal \$([\d.,]+)/, "total", mail);
  const total = printedPesos(totalM(1));
  // Items: after the branch address (ends «, Chile») up to the points or the subtotal.
  const list = t.match(/, Chile (.+?) (?:Puntos obtenidos|Subtotal)\b/)?.[1] ?? "";
  const items = list
    .replace(/\(\+?\$[\d.]+\)/g, " ")
    .split(/\$[\d.]+/)
    .map((x) => x.replace(/\s+/g, " ").trim())
    .filter(Boolean);
  const method = t.slice(t.lastIndexOf("Total $")).match(/^Total \$[\d.,]+ (.+)$/)?.[1]?.trim() || null;
  return {
    message_id: mail.message_id,
    sent_at_chile: mail.sent_at_chile,
    processor: "club_domino",
    payee: { name: `Club Dominó ${head(2).trim()}`, rut: null, email: null },
    amount: total,
    currency: "clp",
    paid_at_chile: paidAt,
    order_ref: head(1),
    concept: concept(items),
    statement_descriptor: null,
    payment_method: method,
    installments: null,
  };
}

// ─── Eventbrite ──────────────────────────────────────────────────────────────

/** The order mail's subject, in the languages Eventbrite has mailed it in; group 1 = the event. */
const EVENTBRITE_ORDER_SUBJECT =
  /^(?:Your Tickets for|Order Confirmation for|Tus entradas para|Tus boletos para|Confirmaci[oó]n (?:de|del) pedido (?:para|de)|Seus ingressos para|Confirma[cç][aã]o do pedido (?:para|de)) (.+)$/i;

/** A free order: nothing was charged, so there is nothing to pair. */
const EVENTBRITE_FREE =
  /\b(?:Order total|Total del pedido|Total do pedido):? (?:Free|Gratis|Gratuito)\b|\b(?:Free order|Pedido gratuito|Pedido gratis)\b/i;

/** The order total as printed; group 1 = currency marker before, 2 = amount, 3 = marker after. */
const EVENTBRITE_TOTAL = /\b(?:Order total|Total del pedido|Total do pedido):? ((?:CLP|US|R|ARS|MX|€|£)?\s?\$?)\s?([\d.,]+)(?:\s?(CLP|USD|BRL|EUR))?/i;

/**
 * Eventbrite's order confirmation (orders@eventbrite.com until ~2019, noreply@order.eventbrite.com
 * since). The total is the «Order total» line, which includes Eventbrite's fees; only an order in
 * pesos is read — a peso order prints «CLP» on the total, so a bare «$» (dollars or pesos?) throws,
 * as does any other currency.
 */
function decodeEventbriteOrder(mail: ArchivedMail): ProcessorReceipt | null {
  const subject = mail.subject.match(EVENTBRITE_ORDER_SUBJECT);
  if (!subject) return null;
  const t = mail.text;
  if (EVENTBRITE_FREE.test(t)) return null;
  const total = t.match(EVENTBRITE_TOTAL);
  if (!total) {
    // The 2016 layout lists tickets with no price column and no total when the order is free.
    if (!/\$\s?\d/.test(t) && !/\btotal\b/i.test(t)) return null;
    fail(mail, "paid order without an order total");
  }
  const before = (total[1] ?? "").replace(/\s/g, "").toUpperCase();
  const after = (total[3] ?? "").toUpperCase();
  const isClp = before.startsWith("CLP") || after === "CLP";
  if (!isClp) {
    const marker = `${before}${after ? ` ${after}` : ""}`.trim() || "no currency";
    fail(mail, `order total in ${marker} (${total[2]}), not pesos`);
  }
  const amount = printedPesos(total[2]!);
  if (amount === 0) return null;
  const ref = need(t, /\b(?:Order|Pedido) #:? ?(\d+)/, "order number", mail)(1);
  const event = subject[1]!.trim();
  const organizer = t.match(/\b(?:Organized by|Organizado por) (.+?) (?:Here are your tickets|Aqu[ií] est[aá]n|Aqui est[aã]o|Questions|¿Preguntas|D[uú]vidas)/)?.[1]?.trim();
  // Ticket types from the order summary («1 x General Admission CLP$ 12.000»).
  const summary = t.match(/(?:Order Summary|Resumen del pedido|Resumen de pedido|Resumo de pedido|Resumo do pedido) (.+?)(?: View and manage| Visualizar e gerenciar| Ver y administrar| This order is subject| Este pedido)/i)?.[1] ?? "";
  const tickets = [...summary.matchAll(/\b(\d+) x (.+?) (?:CLP|US|R)?\s?\$/g)].map((m) => `${m[1]} x ${m[2]!.trim()}`);
  const eventConcept = [event, ...new Set(tickets)].join(" · ").slice(0, 300);
  return {
    message_id: mail.message_id,
    sent_at_chile: mail.sent_at_chile,
    processor: "eventbrite",
    // The organizer when the mail names one; the current layout only says «Contact the organizer»,
    // and Eventbrite is then the merchant of record that charged the card.
    payee: { name: organizer || "Eventbrite", rut: null, email: null },
    amount,
    currency: "clp",
    paid_at_chile: mail.sent_at_chile,
    order_ref: ref,
    concept: eventConcept,
    statement_descriptor: null,
    payment_method: null,
    installments: null,
  };
}

// ─── miCoca-Cola ─────────────────────────────────────────────────────────────

/** The two mails that confirm a paid order (one per order); later status mails repeat it. */
const MICOCA_ORDER_SUBJECT = /^(?:Hemos recibido tu pedido\b.*\bcon [eé]xito|Pago Aprobado - Pedido N)/i;

/**
 * miCoca-Cola.cl's order confirmation: «Hemos recibido tu pedido … con éxito!» since 2020-06 (the
 * order paid and confirmed), and «Pago Aprobado - Pedido N°…» in its first months, when «Hemos
 * recibido» was mailed before the payment cleared («Estamos esperando la confirmación del pago» —
 * those decode to null and the «Pago Aprobado» of the same order is read instead). The total must
 * equal subtotal + descuentos + despacho, which proves it is what the card was charged.
 */
function decodeMiCocaColaOrder(mail: ArchivedMail): ProcessorReceipt | null {
  if (!MICOCA_ORDER_SUBJECT.test(mail.subject)) return null;
  const t = mail.text;
  if (/esperando la confirmaci[oó]n del pago/i.test(t)) return null;
  const ref = need(t, /Pedido n[º°o]:? ?(\d{10,}(?:-\d+)?)|Detalles del pedido N[º°o] (\d{10,}(?:-\d+)?)/i, "order number", mail);
  const orderRef = t.match(/Pedido n[º°o]:? ?(\d{10,}(?:-\d+)?)/i)?.[1] ?? ref(2);
  const amount = (label: string) => {
    const g = need(t, new RegExp(`\\b${label}:? (?:\\$ ?)?(-?[\\d.]+)(?= |$)`), label, mail)(1);
    const negative = g.startsWith("-");
    // The template groups an amount under a thousand with a leading separator («Descuentos:
    // -.800» = −800); the subtotal + descuentos + despacho = total check below confirms it.
    const digits = (negative ? g.slice(1) : g).replace(/^\.(?=\d{3}$)/, "");
    return negative ? -printedPesos(digits) : printedPesos(digits);
  };
  const subtotal = amount("Subtotal");
  const discounts = amount("Descuentos");
  const shipping = amount("Despacho");
  const total = amount("Total");
  if (subtotal + discounts + shipping !== total) {
    fail(mail, `total ${total} ≠ subtotal ${subtotal} + descuentos ${discounts} + despacho ${shipping}`);
  }
  if (total <= 0) fail(mail, `order total ${total}`);
  const items = need(t, /(?:Detalle del Pedido|Producto\(s\)) (.+?) Subtotal\b/, "order items", mail)(1)
    .split(/\s(?:\d+ [xX] \$ ?[\d.]+|Cantidad: \d+ \$ ?[\d.]+)(?:\s|$)/)
    .map((x) => x.trim())
    .filter(Boolean);
  const method = t.match(/Medio de [Pp]ago:? (.+?) (?:Estamos|Datos de entrega|Pedido recibido|Producto\(s\)|Detalle)/)?.[1]?.trim() || null;
  return {
    message_id: mail.message_id,
    sent_at_chile: mail.sent_at_chile,
    processor: "micoca_cola",
    payee: { name: "miCoca-Cola.cl", rut: null, email: null },
    amount: total,
    currency: "clp",
    paid_at_chile: mail.sent_at_chile,
    order_ref: orderRef,
    concept: items.length > 0 ? [...new Set(items)].join(" · ").slice(0, 300) : null,
    statement_descriptor: null,
    payment_method: method,
    installments: null,
  };
}

// ─── Shops that charge in dollars ────────────────────────────────────────────

/** Dollars to the cent from «178», «13.00» or «139.35». */
function printedDollars(s: string): number {
  if (!/^\d+(?:\.\d{1,2})?$/.test(s)) throw new Error(`not a dollar amount: ${s}`);
  return Number(s);
}

const DYNAVAP_ORDER_SUBJECT = /^(?:DynaVap - Order Confirmation|Thank you for your order with DynaVap)\b/i;

/**
 * DynaVap's order mail, in dollars (the card's dollar side): «DynaVap - Order Confirmation» (2018–19:
 * «Order Number», the items, «Order Total $ 178») and «Thank you for your order with DynaVap» (2020:
 * an Authorize.net receipt, «Order # …», «Order Total $139.35», then the items with their codes).
 */
function decodeDynavap(mail: ArchivedMail): ProcessorReceipt | null {
  if (!DYNAVAP_ORDER_SUBJECT.test(mail.subject)) return null;
  const t = mail.text;
  const ref = need(t, /Order (?:Number:|#) (\S+)/, "order number", mail)(1);
  const total = printedDollars(need(t, /Order Total:? \$ ?([\d.]+)/, "order total", mail)(1));
  let items: string[];
  if (/Item Description Qty Price/.test(t)) {
    // «VCM 113-73-15-00.a The New 2018 "M" 1 $ Order Confirmation …» (the code first, the price may be blank).
    const list = need(t, /Item Description Qty Price(?: Status)? (.+?) Order Subtotal\b/, "item list", mail)(1);
    items = [...list.matchAll(/(?:^| )(?:[A-Z]{3}[- ][\d-]+(?:\.[a-z])? )?(.+?)(?: Coupon: \S+)? (\d+)(?: \$(?: [\d.]+)?)+(?: Order Confirmation)?(?= |$)/g)].map(
      (m) => `${m[1]!.trim()} × ${m[2]}`
    );
  } else {
    // «High-Temp O-Ring Kit Code : POT-1 Weight : 0.004 LBS $5.00 2 $10.00 …»
    items = [...t.matchAll(/(?<=\$[\d.]+ )([^$]+?) Code : .+? Weight : [\d.]+ LBS (?:\$[\d.]+ )?(\d+) \$[\d.]+/g)].map(
      (m) => `${m[1]!.trim()} × ${m[2]}`
    );
  }
  const card = t.match(/Payment Method x{4} x{4} x{4} (\d{4})/)?.[1];
  return {
    message_id: mail.message_id,
    sent_at_chile: mail.sent_at_chile,
    processor: "dynavap",
    payee: { name: "DynaVap", rut: null, email: null },
    amount: total,
    currency: "usd",
    // Mailed the minute the order is placed (its own time is printed in a US zone).
    paid_at_chile: mail.sent_at_chile,
    order_ref: ref,
    concept: concept(items),
    statement_descriptor: null,
    payment_method: card ? `card ${card}` : /Payment Method\(s\) Used: Credit Card/.test(t) ? "Credit Card" : null,
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

  { slug: "calvin_klein", from: "calvinkleinchile@aswgr.com", wantSubject: (s) => CALVIN_KLEIN_ORDER_SUBJECT.test(s), decode: decodeCalvinKlein },
  { slug: "adidas", from: "adidas@cl-info.adidas.com", wantSubject: (s) => ADIDAS_ORDER_SUBJECT.test(s), decode: decodeAdidas },
  { slug: "club_domino", from: "clubdomino.domino.cl", wantSubject: (s) => CLUB_DOMINO_ORDER_SUBJECT.test(s), decode: decodeClubDomino },

  {
    slug: "eventbrite",
    gmraw: "from:(orders@eventbrite.com OR noreply@order.eventbrite.com)",
    wantSubject: (s) => EVENTBRITE_ORDER_SUBJECT.test(s),
    decode: decodeEventbriteOrder,
  },
  {
    slug: "micoca_cola",
    from: "contacto@micoca-cola.cl",
    wantSubject: (s) => MICOCA_ORDER_SUBJECT.test(s),
    decode: decodeMiCocaColaOrder,
  },
  { slug: "dynavap", from: "dynavap.com", wantSubject: (x) => DYNAVAP_ORDER_SUBJECT.test(x), decode: decodeDynavap },
];

export function decodePaymentReceiptMail(processor: PaymentProcessor, mail: ArchivedMail): ProcessorReceipt | null {
  return processor.decode(mail);
}
