import type { BrokerNotification } from "nw-tracker-contracts";

/**
 * Broker notification e-mails → typed events, and those events → the server's
 * `broker.notifications` payload.
 *
 * Fintual and Racional both e-mail a notification for every real movement, and those e-mails
 * carry MORE than the app UIs expose: Fintual's subject lines contain the amount and the exact
 * share count, and Racional's contain the CLP→USD wallet conversion that its movements list
 * never shows. Reading them is also far cheaper than driving a browser — no login, no 2FA, no
 * reputation cost — which is why e-mail is the change detector and the Racional scrape only
 * runs when a new transaction e-mail says there is something to fetch.
 *
 * Everything here is parsed from the SUBJECT plus Gmail's short snippet. The HTML bodies are
 * ~30KB of table layout carrying no data the subject lacks, so they are deliberately not used.
 *
 * Patterns below were read off real messages (2026-03 … 2026-08); anything unrecognised is
 * classified `other` and simply does not trigger anything, so a new marketing template can
 * never be mistaken for a movement.
 *
 * What the mail says is read here; what it means for the ledger (is it bookable, does the
 * Racional browser need to open) is the server's call — it holds the ledger and the crawl state.
 */

export type BrokerName = "fintual" | "racional";

export type BrokerEmailKind =
  | "dividend"
  | "buy"
  | "order_placed"
  | "deposit"
  | "withdrawal_requested"
  | "withdrawal_paid"
  | "cash_returned"
  | "wallet_funded"
  | "portfolio_buy"
  | "statement"
  | "certificate"
  | "other";

export type BrokerEmailInput = {
  /** IMAP Message-ID of the staged mail; carried onto the event as synthesis provenance. */
  message_id?: string | null;
  sender: string;
  subject: string;
  /** Gmail's short preview; carries Racional's units/price line. */
  snippet?: string | null;
  /** RFC date of the message. */
  date: string;
};

export type BrokerEmailEvent = {
  broker: BrokerName | null;
  kind: BrokerEmailKind;
  /** True for kinds that represent money actually moving. */
  is_transaction: boolean;
  /**
   * Whether the e-mail carries everything needed to build the movement.
   *
   * Not every notification does. Racional's dividend mail only says «acabas de ganar dividendos
   * por tu inversión en VEA» — instrument but no amount — so it is a NUDGE: proof something
   * happened, and the reason to open the browser. A complete e-mail (Fintual's dividend and
   * reinvestment, Racional's purchase confirmations) needs no fetch at all.
   */
  is_complete: boolean;
  ticker: string | null;
  /** The fund a Fintual buy names («… acciones de <fund name>») — the ticker comes from it. */
  fund_name: string | null;
  /** The goal a Fintual retiro was paid from («Pagamos tu retiro de 🏦 Reserva» → «Reserva»). */
  goal_name: string | null;
  /** The amount the broker actually moved. Null when the mail states only a gross figure. */
  amount: number | null;
  /**
   * The amount as the mail STATES it when that figure is gross of a withholding the broker
   * never credits — informational, never bookable. Racional's «Recibiste USD $2,75 en dividendos
   * de SOXX» is the gross dividend; the wallet received 2,34 after the 15% US withholding
   * (found 2026-09-22 when Racional USD would not close to 0), and the mail body carries no
   * amount at all. So the event stays a nudge for the crawl, whose API prints gross, tax and net.
   */
  gross_amount: number | null;
  currency: "clp" | "usd" | null;
  /** Decimal string — share counts run to 9 decimals and must not touch a float. */
  units: string | null;
  price: number | null;
  /**
   * CLP leg of a USD event, when the mail states it — Racional's «Agregaste USD … a tu
   * Billetera» body prints the pesos the dollars were bought with («con tu depósito de $X»).
   */
  clp_amount: number | null;
  /**
   * Where a Fintual retiro's pesos went, as the mail says: «Se pagó a tu cuenta de banco» (the
   * bank) or «quedaron disponibles para invertir en Fintual» (the Fintual balance, kept there up
   * to 7 days before Fintual wires it back). Null when the mail says neither.
   */
  paid_to: "bank" | "fintual" | null;
  occurred_at: string;
  subject: string;
  /** IMAP Message-ID of the source mail (null for hand-built inputs). */
  message_id: string | null;
};

/**
 * Fields each kind needs before it can be turned into a ledger movement — for the local report
 * only; the server applies its own rule to what it receives.
 */
const REQUIRED_FIELDS: Partial<Record<BrokerEmailKind, (keyof BrokerEmailEvent)[]>> = {
  dividend: ["ticker", "amount"],
  buy: ["amount", "units"],
  wallet_funded: ["amount"],
  deposit: ["amount"],
  portfolio_buy: ["amount"],
  withdrawal_paid: ["amount"],
  cash_returned: ["amount"],
};

function isComplete(event: BrokerEmailEvent): boolean {
  if (!event.is_transaction) return false;
  const required = REQUIRED_FIELDS[event.kind];
  if (!required) return false;
  return required.every((f) => event[f] != null && event[f] !== "");
}

const FINTUAL_SENDERS = ["hola@fintual.com", "notificaciones@acciones.fintual.com"];
const RACIONAL_SENDERS = ["racional@racional.cl", "notificaciones@notificaciones.racional.cl"];

export function brokerFromSender(sender: string): BrokerName | null {
  const s = String(sender ?? "").toLowerCase();
  if (FINTUAL_SENDERS.some((f) => s.includes(f))) return "fintual";
  if (RACIONAL_SENDERS.some((r) => s.includes(r))) return "racional";
  // Newsletters (fintualist.com, racionalteam@) are deliberately NOT brokers: they are
  // marketing and must never trigger a fetch.
  return null;
}

/**
 * Chilean number → JS number: dots group thousands, comma is the decimal.
 * "1.346,17" → 1346.17; "3.xxx.xxx" → 3000000.
 *
 * Used for SUBJECT amounts only. Racional's message BODY prints US format in the same
 * e-mail ("Precio promedio US$54.41"), where a dot is the decimal — running that through here
 * would read 54,41 as 5.441, a 100× error. Hence two functions rather than one clever one.
 */
export function parseChileanNumber(raw: string): number {
  const text = String(raw ?? "").trim().replace(/\s/g, "");
  if (!/^-?[\d.]*\d(?:,\d+)?$/.test(text)) {
    throw new Error(`Unparseable Chilean-format amount "${raw}"`);
  }
  const n = Number(text.replace(/\./g, "").replace(",", "."));
  if (!Number.isFinite(n)) throw new Error(`Unparseable Chilean-format amount "${raw}"`);
  return n;
}

/** US number → JS number: commas group thousands, dot is the decimal ("1,346.17" → 1346.17). */
export function parseUsNumber(raw: string): number {
  const text = String(raw ?? "").trim().replace(/\s/g, "");
  if (!/^-?[\d,]*\d(?:\.\d+)?$/.test(text)) {
    throw new Error(`Unparseable US-format amount "${raw}"`);
  }
  const n = Number(text.replace(/,/g, ""));
  if (!Number.isFinite(n)) throw new Error(`Unparseable US-format amount "${raw}"`);
  return n;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Share counts keep their decimals as a string; Racional/Fintual print up to 9. */
function decimalString(raw: string): string {
  const t = String(raw ?? "").trim();
  // "0,002152366" (comma decimal) vs "24.74186066" (dot decimal, Racional's body).
  if (t.includes(",")) return t.replace(/\./g, "").replace(",", ".");
  return t;
}

type Matcher = {
  kind: BrokerEmailKind;
  is_transaction: boolean;
  re: RegExp;
  /** Pull fields out of the subject match plus the snippet. */
  read?: (m: RegExpExecArray, snippet: string) => Partial<BrokerEmailEvent>;
};

/**
 * Racional's snippet: "Acciones compradas 24.74186066 Precio promedio US$54.41 Monto comprado
 * US$1346.17". The Margin-era template renders BOTH table column headers before each value
 * ("Acciones compradas Acciones vendidas 8.45850913 … Monto comprado Monto vendido US$4345.96")
 * — the subject («Invertiste en …») is what says the single value is the buy column.
 */
const RE_RACIONAL_BODY =
  /Acciones\s+compradas\s+(?:Acciones\s+vendidas\s+)?([\d.,]+)\s+Precio\s+promedio\s+US\$\s*([\d.,]+)\s+Monto\s+comprado\s+(?:Monto\s+vendido\s+)?US\$\s*([\d.,]+)/i;

const FINTUAL_MATCHERS: Matcher[] = [
  {
    // "Recibiste un dividendo de SPY por 1,67 dólares" (template until 2026-08) — and, since
    // the 2026-09-17 LIN mail, just "Recibiste un dividendo de LIN": the amount moved to the
    // body («Recibiste un dividendo de LIN por US $10,75 y lo asignamos a tu cuenta»). Without
    // an amount anywhere the event stays a transaction but incomplete (a nudge), never silent.
    kind: "dividend",
    is_transaction: true,
    re: /^Recibiste un dividendo de ([A-Z][A-Z0-9.]{0,9})(?: por ([\d.,]+) d[óo]lares)?\s*$/i,
    read: (m, snippet) => {
      const ticker = m[1]!.toUpperCase();
      const body = new RegExp(
        `Recibiste un dividendo de ${escapeRegExp(ticker)} por US \\$\\s*([\\d.,]+)`,
        "i"
      ).exec(snippet);
      const amountRaw = m[2] ?? body?.[1];
      return {
        ticker,
        currency: "usd",
        ...(amountRaw ? { amount: parseChileanNumber(amountRaw) } : {}),
      };
    },
  },
  {
    // "Invertiste US $1,67 dólares en 0,002152366 acciones de State Street SPDR S&P 500 ETF Trust"
    kind: "buy",
    is_transaction: true,
    re: /^Invertiste US \$\s*([\d.,]+) d[óo]lares en ([\d.,]+) acciones de (.+)$/i,
    read: (m) => ({
      amount: parseChileanNumber(m[1]!),
      units: decimalString(m[2]!),
      fund_name: m[3]!.trim(),
      currency: "usd",
    }),
  },
  {
    // "Reinvertimos tu dividendo de LIN" — the DRIP fill since 2026-09-18 (was an «Invertiste …
    // acciones de <fund name>» mail). Ticker in the subject; amount, price and share count in the
    // body: «Monto invertido US $10,75 Precio de la acción US $458,38 Acciones compradas
    // 0,023452157» — Chilean number format, the share count kept as a decimal string.
    kind: "buy",
    is_transaction: true,
    re: /^Reinvertimos tu dividendo de ([A-Z][A-Z0-9.]{0,9})\s*$/i,
    read: (m, snippet) => {
      const amount = /Monto invertido US \$\s*([\d.,]+)/i.exec(snippet);
      const price = /Precio de la acci[óo]n US \$\s*([\d.,]+)/i.exec(snippet);
      const units = /Acciones compradas\s+([\d.,]+)/i.exec(snippet);
      return {
        ticker: m[1]!.toUpperCase(),
        currency: "usd",
        ...(amount ? { amount: parseChileanNumber(amount[1]!) } : {}),
        ...(price ? { price: parseChileanNumber(price[1]!) } : {}),
        ...(units ? { units: decimalString(units[1]!) } : {}),
      };
    },
  },
  {
    // "Invertiremos US $1,67 de tus dólares en …" — the order, not the fill. Not a movement:
    // the matching "Invertiste" arrives when it executes, and counting both would double.
    kind: "order_placed",
    is_transaction: false,
    re: /^Invertiremos US \$\s*([\d.,]+)/i,
    read: (m) => ({ amount: parseChileanNumber(m[1]!), currency: "usd" }),
  },
  // The request is not money moving — the matching "Pagamos" is. Amounts for these live in the
  // body ("Pagamos tu retiro de $2.000.000"), not the subject.
  { kind: "withdrawal_requested", is_transaction: false, re: /^Pediste retirar/i },
  {
    kind: "withdrawal_paid",
    is_transaction: true,
    re: /^Pagamos tu retiro(?: de\s+(.+))?$/i,
    read: (m, snippet) => {
      const body = /Pagamos tu retiro de \$\s*([\d.,]+)/i.exec(snippet);
      // «El retiro se hizo desde el Fondo Mutuo Very Conservative Streep Serie A (900,3208
      // cuotas).» — the cuota count the goal sold, which is what lets the promoted transfer leg
      // reduce the goal's cuota ledger. Only trusted when the body prints exactly ONE count: a
      // goal invested across several funds would print one per fund, and a single number would
      // be wrong for all of them.
      // Since 2026-09-29 a retiro to the Fintual balance prints it as «… Serie A, equivalente a
      // 68,8876 cuotas .» instead.
      const cuotas = [...snippet.matchAll(/(?:\(|equivalente a\s+)([\d.,]+)\s*cuotas\b/gi)];
      const paidTo = /disponibles? para invertir en Fintual/i.test(snippet)
        ? ("fintual" as const)
        : /cuenta de banco|Destino Cuenta/i.test(snippet)
          ? ("bank" as const)
          : null;
      // «Pagamos tu retiro de 🏦 Reserva» → «Reserva»: emoji stripped, whitespace collapsed.
      const goal = (m[1] ?? "")
        .replace(/[\p{Extended_Pictographic}\p{Emoji_Presentation}\uFE0F]/gu, " ")
        .replace(/\s+/g, " ")
        .trim();
      return {
        ...(goal ? { goal_name: goal } : {}),
        ...(body ? { amount: parseChileanNumber(body[1]!), currency: "clp" as const } : {}),
        ...(cuotas.length === 1 ? { units: decimalString(cuotas[0]![1]!) } : {}),
        ...(paidTo ? { paid_to: paidTo } : {}),
      };
    },
  },
  {
    // "Recibimos tu depósito" (since 2026-10): a wire landed in the Fintual balance, waiting to be
    // invested («Recibimos tus $700.000 Decide cómo los quieres invertir. Si no lo haces dentro de
    // los próximos 7 días, devolveremos el depósito…»). The amount is only in the body.
    // Digit-terminated: the sentence may run straight on after the amount.
    kind: "deposit",
    is_transaction: true,
    re: /^Recibimos tu dep[óo]sito\s*$/i,
    read: (_m, snippet) => {
      const body = /Recibimos tus \$\s*([\d.,]*\d)/i.exec(snippet);
      return body ? { amount: parseChileanNumber(body[1]!), currency: "clp" as const } : {};
    },
  },
  {
    // "Compraste dólares": pesos of the Fintual balance converted to dollars — «Compraste US $
    // 711,05 El miércoles 7 de octubre a las 11:24 con tus $700.000 pesos chilenos compraste US $
    // 711,05 a un tipo de cambio de $984,46 CLP/USD». The same event as Racional's «Agregaste USD
    // … a tu Billetera»: dollars bought (amount), the pesos paid (clp_amount), the rate (price).
    kind: "wallet_funded",
    is_transaction: true,
    re: /^Compraste d[óo]lares\s*$/i,
    read: (_m, snippet) => {
      const usd = /Compraste US \$\s*([\d.,]*\d)/i.exec(snippet);
      const clp = /con tus \$\s*([\d.,]*\d) pesos/i.exec(snippet);
      const rate = /tipo de cambio de \$\s*([\d.,]*\d)/i.exec(snippet);
      return {
        currency: "usd" as const,
        ...(usd ? { amount: parseChileanNumber(usd[1]!) } : {}),
        ...(clp ? { clp_amount: parseChileanNumber(clp[1]!) } : {}),
        ...(rate ? { price: parseChileanNumber(rate[1]!) } : {}),
      };
    },
  },
  {
    kind: "cash_returned",
    is_transaction: true,
    re: /^Devolvimos tu saldo/i,
    read: (_m, snippet) => {
      const body = /Devolvimos (?:tus|los)? ?\$\s*([\d.,]+)/i.exec(snippet);
      return body ? { amount: parseChileanNumber(body[1]!), currency: "clp" } : {};
    },
  },
  { kind: "certificate", is_transaction: false, re: /^Certificado de Transacciones/i },
  { kind: "statement", is_transaction: false, re: /^(Cartola mensual|Confirmaci[óo]n de transacciones)/i },
];

const RACIONAL_MATCHERS: Matcher[] = [
  {
    // "Invertiste en Silver Trust ETF iShares (SLV)" — units/price/amount live in the body.
    kind: "buy",
    is_transaction: true,
    re: /^Invertiste en .+?\(([A-Z][A-Z0-9.]{0,9})\)/i,
    read: (m, snippet) => {
      const body = RE_RACIONAL_BODY.exec(snippet);
      // The body is US-formatted even though the subjects of sibling e-mails are Chilean.
      return {
        ticker: m[1]!.toUpperCase(),
        units: body ? decimalString(body[1]!) : null,
        price: body ? parseUsNumber(body[2]!) : null,
        amount: body ? parseUsNumber(body[3]!) : null,
        currency: "usd",
      };
    },
  },
  {
    // "Recibiste USD $2,75 en dividendos de SOXX" — the template since 2026-09-18 carries an
    // amount in the subject, but it is the GROSS dividend: Racional credits the net after the
    // 15% US withholding (2,34 for that mail), and nothing in the mail says so. Booking the
    // subject figure overstated Racional USD by every dividend's tax (2026-09-22), so the
    // amount is kept as `gross_amount` for the record and the event stays a nudge — the crawl
    // reads gross, tax and net from Racional's own dividends API.
    kind: "dividend",
    is_transaction: true,
    re: /^Recibiste USD \$\s*([\d.,]+) en dividendos de ([A-Z][A-Z0-9.]{0,9})/i,
    read: (m) => ({
      ticker: m[2]!.toUpperCase(),
      gross_amount: parseChileanNumber(m[1]!),
      currency: "usd",
    }),
  },
  {
    // "Recibiste dividendos de VEA 💸" (until 2026-09) — instrument only: a nudge for the crawl.
    kind: "dividend",
    is_transaction: true,
    re: /^Recibiste dividendos de ([A-Z][A-Z0-9.]{0,9})/i,
    read: (m) => ({ ticker: m[1]!.toUpperCase(), currency: "usd" }),
  },
  {
    // "Agregaste USD $5.344,04 a tu Billetera" — the CLP→USD conversion, which the movements
    // list in the app does not show at all. The body carries the CLP leg: «Estos dólares los
    // compraste con tu depósito de $4.xxx.xxx, a un precio promedio de $920,39 por dólar.»
    kind: "wallet_funded",
    is_transaction: true,
    re: /^Agregaste USD \$\s*([\d.,]+) a tu Billetera/i,
    read: (m, snippet) => {
      // Digit-terminated: the body continues «…de $4.xxx.xxx, a un precio…» and a greedy
      // [\d.,]+ would swallow the sentence comma.
      const clp = /con tu dep[óo]sito de \$\s*([\d.,]*\d)/i.exec(snippet);
      return {
        amount: parseChileanNumber(m[1]!),
        currency: "usd" as const,
        ...(clp ? { clp_amount: parseChileanNumber(clp[1]!) } : {}),
      };
    },
  },
  {
    // "Tu depósito de CLP $3.xxx.xxx está listo para invertir"
    kind: "deposit",
    is_transaction: true,
    re: /^Tu dep[óo]sito de CLP \$\s*([\d.,]+)/i,
    read: (m) => ({ amount: parseChileanNumber(m[1]!), currency: "clp" }),
  },
  {
    // "Invertiste $3.xxx.xxx en tu Portafolio IPSA 😎"
    kind: "portfolio_buy",
    is_transaction: true,
    re: /^Invertiste \$\s*([\d.,]+) en tu Portafolio/i,
    read: (m) => ({ amount: parseChileanNumber(m[1]!), currency: "clp" }),
  },
  { kind: "statement", is_transaction: false, re: /^(Tus Inversiones por Racional|Transacciones Racional Stocks)/i },
];

/**
 * Classify one e-mail. Unknown subjects come back as `other` with `is_transaction: false`, so
 * marketing, login alerts and prospectus notices never trigger a fetch.
 */
/**
 * Subjects arrive HTML-escaped — Fintual's purchase subject literally contains
 * `S&amp;P 500`, so a pattern written with a plain `&` silently never matches. Decoding here
 * keeps every matcher free of that trap.
 */
export function normalizeSubject(raw: string): string {
  return String(raw ?? "")
    .replaceAll("&amp;", "&")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&nbsp;", " ")
    .trim();
}

export function classifyBrokerEmail(input: BrokerEmailInput): BrokerEmailEvent {
  const broker = brokerFromSender(input.sender);
  const subject = normalizeSubject(input.subject);
  const snippet = String(input.snippet ?? "");
  const base: BrokerEmailEvent = {
    broker,
    kind: "other",
    is_transaction: false,
    is_complete: false,
    ticker: null,
    fund_name: null,
    goal_name: null,
    amount: null,
    gross_amount: null,
    currency: null,
    units: null,
    price: null,
    clp_amount: null,
    paid_to: null,
    occurred_at: input.date,
    subject,
    message_id: input.message_id ?? null,
  };
  if (!broker) return base;

  const matchers = broker === "fintual" ? FINTUAL_MATCHERS : RACIONAL_MATCHERS;
  for (const matcher of matchers) {
    const m = matcher.re.exec(subject);
    if (!m) continue;
    const event: BrokerEmailEvent = {
      ...base,
      kind: matcher.kind,
      is_transaction: matcher.is_transaction,
      ...(matcher.read ? matcher.read(m, snippet) : {}),
    };
    return { ...event, is_complete: isComplete(event) };
  }
  return base;
}

export type BrokerEmailScan = {
  events: BrokerEmailEvent[];
  /** Money notifications, collapsed by Message-ID (see collapseBrokerEmailEventsByMessageId). */
  transactions: BrokerEmailEvent[];
  /**
   * Mail from a broker whose subject matched nothing. Almost always marketing — but a NEW
   * transactional template would land here too, and silently ignoring it is how a movement
   * goes missing. Reported so a changed template is noticed rather than assumed benign.
   */
  unrecognised: BrokerEmailEvent[];
};

/** Fields whose presence makes one parse of the same mail richer than another. */
function eventRichness(e: BrokerEmailEvent): number {
  return (
    (e.amount != null ? 1 : 0) +
    (e.gross_amount != null ? 1 : 0) +
    (e.clp_amount != null ? 1 : 0) +
    (e.units != null ? 1 : 0) +
    (e.price != null ? 1 : 0) +
    (e.paid_to != null ? 1 : 0)
  );
}

/**
 * One mail can sit in several scan files: scans accumulate on disk and are all re-read every
 * run, the fetcher's IMAP `SINCE` is day-granular so the watermark message's whole day comes
 * back on the next poll, and the snippet cap changed over time. Collapse by Message-ID, keeping
 * the richest parse. Every importer that plans writes from scan files MUST go through this —
 * a duplicated retiro mail planned twice targets the same checking credit twice, and the
 * second promote throws inside the batch transaction (2026-09-01: 39 consecutive failed runs,
 * nothing written). Events without a Message-ID (hand-built inputs) pass through untouched.
 */
export function collapseBrokerEmailEventsByMessageId(
  events: readonly BrokerEmailEvent[]
): BrokerEmailEvent[] {
  const byId = new Map<string, BrokerEmailEvent>();
  const out: BrokerEmailEvent[] = [];
  for (const e of events) {
    if (!e.message_id) {
      out.push(e);
      continue;
    }
    const prev = byId.get(e.message_id);
    if (!prev || eventRichness(e) > eventRichness(prev)) byId.set(e.message_id, e);
  }
  return [...out, ...byId.values()];
}

export function scanBrokerEmails(inputs: readonly BrokerEmailInput[]): BrokerEmailScan {
  const events = inputs.map(classifyBrokerEmail);
  return {
    events,
    transactions: collapseBrokerEmailEventsByMessageId(events.filter((e) => e.is_transaction)),
    unrecognised: events.filter((e) => e.broker != null && e.kind === "other"),
  };
}

const NOTIFICATION_KINDS = new Set<BrokerNotification["kind"]>([
  "dividend",
  "buy",
  "deposit",
  "withdrawal_paid",
  "cash_returned",
  "wallet_funded",
  "portfolio_buy",
]);

/** One money mail as the server's canonical notification. */
export function toBrokerNotification(e: BrokerEmailEvent): BrokerNotification {
  if (!e.message_id) throw new Error(`Broker e-mail «${e.subject}» has no Message-ID`);
  const kind = e.kind as BrokerNotification["kind"];
  if (!NOTIFICATION_KINDS.has(kind)) throw new Error(`Broker e-mail «${e.subject}»: ${e.kind} is not a money notification`);
  const occurred = new Date(e.occurred_at);
  if (Number.isNaN(occurred.getTime())) throw new Error(`Broker e-mail «${e.subject}» has an unparseable date "${e.occurred_at}"`);
  return {
    message_id: e.message_id,
    occurred_at: occurred.toISOString(),
    subject: e.subject,
    kind,
    ticker: e.ticker,
    fund_name: e.fund_name,
    goal_name: e.goal_name,
    amount: e.amount,
    gross_amount: e.gross_amount,
    currency: e.currency,
    units: e.units,
    price: e.price,
    clp_amount: e.clp_amount,
    paid_to: e.paid_to === "fintual" ? "broker_balance" : e.paid_to,
  };
}

/** Every money mail one broker has sent, oldest first. */
export function brokerNotificationsFromScan(scan: BrokerEmailScan, broker: BrokerName): BrokerNotification[] {
  return scan.transactions
    .filter((e) => e.broker === broker)
    .map(toBrokerNotification)
    .sort((a, b) => a.occurred_at.localeCompare(b.occurred_at));
}
