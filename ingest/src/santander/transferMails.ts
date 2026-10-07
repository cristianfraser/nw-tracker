/**
 * Santander's transfer mails, decoded into what each states: who sent how much to whom, from and
 * to which account, on which day, with the payee's or sender's name, RUT, bank and e-mail.
 *
 * Every layout the bank used since 2015 is read here:
 *  - outgoing to a third party: «Aviso de Transferencia de fondos» (2016–2018, «Label : value»),
 *    «Comprobante Transferencia de fondos … realizada con fecha» (2019–2023, two variants — one
 *    prints every label and then every value), and «Te enviamos el detalle de la transferencia
 *    realizada el …» (2024 on, «Datos de origen / Datos de destino»);
 *  - incoming: «nuestro cliente X ha instruido una transferencia … a su cuenta» (2015–2023),
 *    «nuestro cliente X realizó una transferencia a tu cuenta» (2024 on), and an employer's
 *    «por instrucción de nuestro cliente X hoy dd/mm/yyyy hh:mm hemos realizado una transferencia»;
 *  - between the client's own Santander products (corriente, vista, línea de crédito);
 *  - a scheduled transfer that ran («transferencia programada que se acaba de realizar»), and the
 *    notice that one was scheduled, which moves no money.
 *
 * Nothing is matched here: a mail states a transfer, and the server pairs it with the bank row.
 * A transfer between two of the client's own accounts produces a mail for each side (the receipt
 * and the recipient's notice); both are decoded, and the pairing keeps one per bank row.
 */

export type TransferParty = {
  name: string | null;
  rut: string | null;
  bank: string | null;
  account_type: string | null;
  account_number: string | null;
  email: string | null;
};

export type TransferNoticeKind =
  /** Money the client sent to someone (or to an own account at another bank). */
  | "outgoing"
  /** Money someone sent to the client. */
  | "incoming"
  /** Between two of the client's Santander products. */
  | "between_own_products"
  /** A scheduled transfer being set up: no money moved. */
  | "schedule_created";

export type TransferNotice = {
  message_id: string;
  sent_at_chile: string;
  subject: string;
  kind: TransferNoticeKind;
  /** The day the mail states (dd/mm/yyyy in the text), else the day it was sent. */
  date: string;
  amount: number;
  from: TransferParty;
  to: TransferParty;
  comment: string | null;
  /** True when the transfer was a scheduled one running. */
  scheduled: boolean;
};

type ArchivedMail = { message_id: string; sent_at_chile: string; subject: string; text: string };

const EMAIL_RE = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/;
const TYPE_RE = /\b(Cuenta Corriente(?: M\/L)?|Cuenta Vista|Cuenta de Ahorro|Cuenta RUT|Chequera Electrónica|Chequera Electronica|Línea de Crédito|Linea de Credito|CUENTA CORRIENTE M\/L|CUENTA VISTA)\b/i;

const MONTHS: Record<string, string> = {
  enero: "01", febrero: "02", marzo: "03", abril: "04", mayo: "05", junio: "06",
  julio: "07", agosto: "08", septiembre: "09", octubre: "10", noviembre: "11", diciembre: "12",
};

function clean(text: string): string {
  return text.replace(/Â/g, " ").replace(/ /g, " ").replace(/\s+/g, " ").trim();
}

/** Pesos as printed: «2.000.-», «$ 1.300.000», «$13.000», «16000». */
function pesos(raw: string, what: string, mail: ArchivedMail): number {
  const digits = raw.replace(/\.-?$/, "").replace(/\./g, "").trim();
  if (!/^\d+$/.test(digits)) throw new Error(`${mail.sent_at_chile} «${mail.subject}»: unreadable ${what} «${raw}»`);
  return Number(digits);
}

function printedDate(text: string, mail: ArchivedMail): string {
  const dmy = text.match(/\b(\d{1,2})\s*\/\s*(\d{1,2})\s*\/\s*(\d{4})/);
  if (dmy) return `${dmy[3]}-${dmy[2]!.padStart(2, "0")}-${dmy[1]!.padStart(2, "0")}`;
  const long = text.match(/\b(\d{1,2}) de ([A-Za-zé]+) de(?:l)? (\d{4})/i);
  if (long && MONTHS[long[2]!.toLowerCase()]) return `${long[3]}-${MONTHS[long[2]!.toLowerCase()]}-${long[1]!.padStart(2, "0")}`;
  return mail.sent_at_chile.slice(0, 10);
}

const EMPTY_PARTY: TransferParty = { name: null, rut: null, bank: null, account_type: null, account_number: null, email: null };

const COLON_LABELS: [keyof TransferParty | "comment" | "skip", RegExp][] = [
  ["bank", /^Banco$/i],
  ["account_type", /^Tipo (?:de )?[Cc]uenta$/i],
  ["account_number", /^(?:Cuenta (?:N\S*|Nro\.)|N[º°?]? de cuenta)$/i],
  ["rut", /^Rut$/i],
  ["name", /^Nombre$/i],
  ["email", /^(?:Mail|E-mail)$/i],
  ["comment", /^Comentarios?$/i],
  ["skip", /^Saldo$/i],
];
const COLON_LABEL_RE = /(Banco|Tipo (?:de )?[Cc]uenta|Cuenta (?:N\S*|Nro\.)|N[º°?]? de cuenta|Rut|Nombre|Mail|E-mail|Comentarios?|Saldo)\s*:/g;

function labelKey(label: string): keyof TransferParty | "comment" | "skip" {
  for (const [k, re] of COLON_LABELS) if (re.test(label.trim())) return k;
  throw new Error(`unknown label «${label}»`);
}

/** Two values printed after two labels («Cuenta Nro.: Rut: 0-000-… 76.413.921-6»), split by what each looks like. */
function splitPair(a: string, b: string, value: string): Record<string, string> {
  const v = value.trim();
  const keys = [a, b].join("+");
  if (keys === "bank+account_type") {
    const t = v.match(TYPE_RE);
    if (!t) return { bank: v };
    return { bank: v.slice(0, t.index).trim(), account_type: t[0] };
  }
  if (keys === "account_number+rut") {
    const m = v.match(/^(\S+)\s+(\S+)$/);
    if (m) return { account_number: m[1]!, rut: m[2]! };
    // One value only: the bank left the number out, and what is printed is the RUT.
    if (/^\d{1,2}\.\d{3}\.\d{3}-[\dkK]$/.test(v)) return { rut: v };
    throw new Error(`cannot split account and RUT in «${v}»`);
  }
  if (keys === "rut+name") {
    const m = v.match(/^(\S+)\s+(.+)$/);
    if (!m) throw new Error(`cannot split RUT and name in «${v}»`);
    return { rut: m[1]!, name: m[2]! };
  }
  if (keys === "name+email") {
    const e = v.match(EMAIL_RE);
    return e ? { name: v.replace(e[0], "").trim(), email: e[0] } : { name: v };
  }
  if (keys === "bank+account_number") {
    const m = v.match(/^(.+?)\s+(\S+)$/);
    if (!m) throw new Error(`cannot split bank and account in «${v}»`);
    return { bank: m[1]!, account_number: m[2]! };
  }
  if (keys === "rut+skip") {
    const m = v.match(/^(\S+)/);
    return m ? { rut: m[1]! } : {};
  }
  if (keys === "account_type+account_number") {
    // 2016–2018 print «Tipo de cuenta : Cuenta N : 16978309» for some banks: no type, just the number.
    const t = v.match(TYPE_RE);
    if (!t) return { account_number: v };
    return { account_type: t[0], account_number: v.slice((t.index ?? 0) + t[0].length).trim() };
  }
  throw new Error(`no rule to split ${keys} in «${v}»`);
}

/** A party from one section of a mail. */
function party(section: string): TransferParty {
  const s = section.trim();
  const out: Record<string, string | null> = {};
  // 2024 on: «Nombre X RUT Y Banco Z Tipo de cuenta W Nº de cuenta N E-mail M» / «Tipo de cuenta W Nº de cuenta N RUT Y Nombre X».
  if (!/:/.test(s.replace(/https?:\S+/g, ""))) {
    const grab = (re: RegExp) => s.match(re)?.[1]?.trim() ?? null;
    const stop = "(?= RUT | Banco | Tipo de cuenta | N[º°?] de cuenta | E-mail | Nombre | Comentario|$)";
    return {
      name: grab(new RegExp(`Nombre (.+?)${stop}`)),
      rut: grab(new RegExp(`RUT (\\S+)`)),
      bank: grab(new RegExp(`Banco (.+?)${stop}`)),
      account_type: grab(new RegExp(`Tipo de cuenta (.+?)${stop}`)),
      account_number: grab(new RegExp(`N[º°?] de cuenta (\\S+)`)),
      email: grab(new RegExp(`E-mail (\\S+)`)),
    };
  }
  const labels = [...s.matchAll(COLON_LABEL_RE)];
  if (labels.length === 0) return { ...EMPTY_PARTY, name: s || null };
  const pending: string[] = [];
  labels.forEach((m, i) => {
    const key = labelKey(m[1]!);
    const valueEnd = i + 1 < labels.length ? labels[i + 1]!.index! : s.length;
    const value = s.slice(m.index! + m[0].length, valueEnd).trim();
    if (!value) {
      pending.push(key);
      return;
    }
    if (pending.length === 0) {
      out[key] = value;
      return;
    }
    // Scrambled layout: the earlier label(s) had no value, so this value holds theirs too.
    const parts = splitPair(pending[pending.length - 1]!, key, value);
    for (const [k, v] of Object.entries(parts)) out[k] = v;
    pending.length = 0;
  });
  const val = (k: keyof TransferParty) => {
    const v = out[k];
    return v == null || v === "" || v === "null" ? null : v;
  };
  return {
    name: val("name"),
    rut: val("rut"),
    bank: val("bank"),
    account_type: val("account_type"),
    account_number: val("account_number"),
    email: val("email"),
  };
}

function between(text: string, start: RegExp, end: RegExp): string {
  const s = text.search(start);
  if (s < 0) return "";
  const after = text.slice(s).replace(start, "");
  const e = after.search(end);
  return e < 0 ? after : after.slice(0, e);
}

const TAIL = /(Antes de imprimir|Si tienes cualquier duda|Si tiene cualquier duda|Nota:|Atentamente|Recuerda que puedes|DATOS DE AGENDAMIENTO|$)/;

/** One mail → its transfer notice, or null when the mail is not a transfer. Throws on a transfer it cannot read. */
export function decodeTransferMail(mail: ArchivedMail): TransferNotice | null {
  const text = clean(mail.text);
  const base = { message_id: mail.message_id, sent_at_chile: mail.sent_at_chile, subject: mail.subject };
  if (!/transferencia/i.test(mail.subject) && !/transferencia/i.test(text.slice(0, 200))) return null;

  // An employer's payroll wire: «por instrucción de nuestro cliente X hoy dd/mm/yyyy hh:mm … monto N».
  const wire = text.match(/por instrucci[oó]n de nuestro cliente (.+?) hoy (\d{2}\/\d{2}\/\d{4}).*?cuenta Nro\.\s*(\d+) del (.+?) por el monto ([\d.]+)/i);
  if (wire) {
    return {
      ...base, kind: "incoming", date: printedDate(wire[2]!, mail), amount: pesos(wire[5]!, "amount", mail), scheduled: false,
      from: { name: wire[1]!.trim(), rut: null, bank: null, account_type: null, account_number: null, email: null },
      to: { name: null, rut: null, bank: wire[4]!.trim(), account_type: null, account_number: wire[3]!, email: null },
      comment: text.match(/provista por nuestro cliente:\s*(.+?)\s*Atentamente/i)?.[1]?.trim() ?? null,
    };
  }

  // Incoming: someone «ha instruido / realizó una transferencia … a su/tu cuenta».
  const sender = text.match(/nuestro\(a\)? cliente (.+?) (?:ha instru[ií]do|realiz[oó]) una transferencia/i) ??
    text.match(/nuestro cliente (.+?) (?:ha instru[ií]do|realiz[oó]) una transferencia/i);
  if (sender) {
    const amount =
      text.match(/Monto (?:de la operaci[oó]n|transferido)\s*:?\s*(?:\d{1,2}\.\d{3}\.\d{3}-[\dkK]\s+)?\$?\s*([\d.]+)/i)?.[1] ??
      text.match(/Monto de la Operacion:\s*[\d.]+-[\dkK]\s+([\d.]+)/i)?.[1];
    if (!amount) throw new Error(`${mail.sent_at_chile} «${mail.subject}»: incoming transfer without an amount`);
    const dest = between(text, /(Banco de destino|Cuenta de destino|Datos de destino)/i, /(Monto|Comentario|Nuestro Cliente|Antes de imprimir|$)/i);
    const destFull = text
      .slice(text.search(/(Banco de destino|Cuenta de destino|Datos de destino)/i))
      .replace(/(Monto de la operaci[oó]n\s*:\s*\$|Nuestro Cliente le env).*$/i, "");
    const to = party(destFull.replace(/(Banco de destino|Cuenta de destino Nro\.|Rut destinatario|Monto de la Operacion)\s*:/gi, (m) => m.replace(/Banco de destino/i, "Banco").replace(/Cuenta de destino Nro\./i, "Cuenta Nro.").replace(/Rut destinatario/i, "Rut").replace(/Monto de la Operacion/i, "Saldo")).replace(/Comentario.*$/, ""));
    return {
      ...base, kind: "incoming", date: printedDate(text, mail), amount: pesos(amount, "amount", mail), scheduled: false,
      from: { name: sender[1]!.trim(), rut: null, bank: null, account_type: null, account_number: null, email: null },
      to: { ...to, account_number: to.account_number ?? dest.match(/\d{6,}/)?.[0] ?? null },
      comment: (text.match(/(?:Comentario|siguiente comentario)\s*:?\s*(.*?)\s*(?:Atentamente|Si tienes|Si tiene|Nota:|Antes de imprimir|$)/i)?.[1] ?? "").trim() || null,
    };
  }

  const scheduleCreated = /agendamiento de transferencia/i.test(text);
  const scheduledRun = /transferencia programada que se acaba de realizar/i.test(text);
  const ownProducts = /entre productos/i.test(mail.subject) || /entre productos/i.test(text.slice(0, 120));

  const amountRaw =
    text.match(/Monto (?:de [Tt]ransferencia|transferido)\s*:?\s*\$?\s*([\d.]+-?)/i)?.[1];
  if (!amountRaw) {
    if (/transferencia/i.test(mail.subject)) throw new Error(`${mail.sent_at_chile} «${mail.subject}»: transfer without an amount`);
    return null;
  }
  const amount = pesos(amountRaw.replace(/-$/, ""), "amount", mail);
  const originRaw = between(text, /(ORIGEN|Datos de origen)/, /(DESTINO|Datos de destino)/);
  const destRaw = between(text, /(DESTINO|Datos de destino)/, TAIL);
  if (!originRaw && !destRaw) throw new Error(`${mail.sent_at_chile} «${mail.subject}»: transfer without origin and destination`);
  // The comment sits in the origin section (2019 on) or after the payee (2016–2018).
  const commentIn = (section: string) => section.match(/Comentarios?\s*:?\s*(.*?)\s*(?=Banco\s*:|$)/i);
  const commentMatch = /Comentarios?/i.test(originRaw) ? commentIn(originRaw) : commentIn(destRaw);
  const comment = commentMatch?.[1]?.replace(/\bnull\b/, "").trim() || null;
  const origin = party(originRaw.replace(/Comentarios?\s*:?.*$/i, "").replace(/Saldo\s*:\s*[\d.]+/g, ""));
  const dest = party(destRaw.replace(/Comentarios?\s*:?.*$/i, "").replace(/Saldo\s*:\s*[\d.]+/g, ""));
  return {
    ...base,
    kind: scheduleCreated ? "schedule_created" : ownProducts ? "between_own_products" : "outgoing",
    date: printedDate(text, mail),
    amount,
    from: origin,
    to: dest,
    comment,
    scheduled: scheduledRun,
  };
}
