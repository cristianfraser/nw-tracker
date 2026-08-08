/**
 * Broker notification e-mails → typed events.
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
  amount: number | null;
  currency: "clp" | "usd" | null;
  /** Decimal string — share counts run to 9 decimals and must not touch a float. */
  units: string | null;
  price: number | null;
  occurred_at: string;
  subject: string;
};

/** Fields each kind needs before it can be turned into a ledger movement. */
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

/** Racional's snippet: "Acciones compradas 24.74186066 Precio promedio US$54.41 Monto comprado US$1346.17". */
const RE_RACIONAL_BODY =
  /Acciones\s+compradas\s+([\d.,]+)\s+Precio\s+promedio\s+US\$\s*([\d.,]+)\s+Monto\s+comprado\s+US\$\s*([\d.,]+)/i;

const FINTUAL_MATCHERS: Matcher[] = [
  {
    // "Recibiste un dividendo de SPY por 1,67 dólares"
    kind: "dividend",
    is_transaction: true,
    re: /^Recibiste un dividendo de ([A-Z][A-Z0-9.]{0,9}) por ([\d.,]+) d[óo]lares/i,
    read: (m) => ({ ticker: m[1]!.toUpperCase(), amount: parseChileanNumber(m[2]!), currency: "usd" }),
  },
  {
    // "Invertiste US $1,67 dólares en 0,002152366 acciones de State Street SPDR S&P 500 ETF Trust"
    kind: "buy",
    is_transaction: true,
    re: /^Invertiste US \$\s*([\d.,]+) d[óo]lares en ([\d.,]+) acciones de (.+)$/i,
    read: (m) => ({
      amount: parseChileanNumber(m[1]!),
      units: decimalString(m[2]!),
      currency: "usd",
    }),
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
    re: /^Pagamos tu retiro/i,
    read: (_m, snippet) => {
      const body = /Pagamos tu retiro de \$\s*([\d.,]+)/i.exec(snippet);
      // «El retiro se hizo desde el Fondo Mutuo Very Conservative Streep Serie A (900,3208
      // cuotas).» — the cuota count the goal sold, which is what lets the promoted transfer leg
      // reduce the goal's cuota ledger. Only trusted when the body prints exactly ONE count: a
      // goal invested across several funds would print one per fund, and a single number would
      // be wrong for all of them.
      const cuotas = [...snippet.matchAll(/\(([\d.,]+)\s*cuotas\)/gi)];
      return {
        ...(body ? { amount: parseChileanNumber(body[1]!), currency: "clp" as const } : {}),
        ...(cuotas.length === 1 ? { units: decimalString(cuotas[0]![1]!) } : {}),
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
    // "Recibiste dividendos de VEA 💸"
    kind: "dividend",
    is_transaction: true,
    re: /^Recibiste dividendos de ([A-Z][A-Z0-9.]{0,9})/i,
    read: (m) => ({ ticker: m[1]!.toUpperCase(), currency: "usd" }),
  },
  {
    // "Agregaste USD $5.344,04 a tu Billetera" — the CLP→USD conversion, which the movements
    // list in the app does not show at all.
    kind: "wallet_funded",
    is_transaction: true,
    re: /^Agregaste USD \$\s*([\d.,]+) a tu Billetera/i,
    read: (m) => ({ amount: parseChileanNumber(m[1]!), currency: "usd" }),
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
    amount: null,
    currency: null,
    units: null,
    price: null,
    occurred_at: input.date,
    subject,
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
  /** Transaction e-mails per broker. */
  transactionsByBroker: Record<BrokerName, BrokerEmailEvent[]>;
  /** Fully-described movements — importable straight from the e-mail, no browser needed. */
  importable: BrokerEmailEvent[];
  /** Real activity the e-mail does not fully describe: the reason to open the browser. */
  nudges: BrokerEmailEvent[];
  /** Brokers with a nudge AND a fetcher to answer it. */
  needsFetch: BrokerName[];
  /**
   * Nudges for brokers that have no fetcher — Fintual is e-mail-only, so an incomplete
   * notification there is something to look at by hand, not something to scrape. Reporting it
   * as "needs fetch" would ask the runner to do something that does not exist.
   */
  unresolved: BrokerEmailEvent[];
  /**
   * Mail from a broker whose subject matched nothing. Almost always marketing — but a NEW
   * transactional template would land here too, and silently ignoring it is how a movement
   * goes missing. Reported so a changed template is noticed rather than assumed benign.
   */
  unrecognised: BrokerEmailEvent[];
};

/** Brokers this project can actually drive a browser against. */
const FETCHABLE: ReadonlySet<BrokerName> = new Set<BrokerName>(["racional"]);

/**
 * Scan a batch of e-mails and decide what, if anything, needs fetching.
 *
 * A broker is fetched only when it has a NUDGE — activity the e-mail proves but does not
 * describe. A day of nothing but complete e-mails (or nothing but newsletters) leaves the
 * browser closed, which is the point: every fetch costs reputation with these sites.
 */
export function scanBrokerEmails(inputs: readonly BrokerEmailInput[]): BrokerEmailScan {
  const events = inputs.map(classifyBrokerEmail);
  const transactions = events.filter((e) => e.is_transaction);
  const nudges = transactions.filter((e) => !e.is_complete);
  return {
    events,
    transactionsByBroker: {
      fintual: transactions.filter((e) => e.broker === "fintual"),
      racional: transactions.filter((e) => e.broker === "racional"),
    },
    importable: transactions.filter((e) => e.is_complete),
    nudges,
    needsFetch: [
      ...new Set(
        nudges
          .map((e) => e.broker)
          .filter((b): b is BrokerName => b != null && FETCHABLE.has(b))
      ),
    ],
    unresolved: nudges.filter((e) => e.broker != null && !FETCHABLE.has(e.broker)),
    unrecognised: events.filter((e) => e.broker != null && e.kind === "other"),
  };
}
