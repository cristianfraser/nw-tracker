import type { IncomingWireNotice } from "nw-tracker-contracts";
import { parseChileanNumber } from "../formats/chileanNumber.js";

/**
 * Banks' mails about a wire INTO the client's account → `bank_account.incoming_wires` notices.
 *
 * - Banco Security «Envío de Transferencia»: a copy of the SWIFT MT103 Security sent for its
 *   customer (Fintual's dollar withdrawals). Plain text, field tags in order: `20:` sender's
 *   reference, `32A:` value date / currency / amount, `50K:` ordering customer, `57A:` the
 *   beneficiary's bank (BIC), `59F:` beneficiary, `70:` remittance information.
 * - Santander «AVISO DE LIQUIDACION DE ORDEN DE PAGO RECIBIDA»: «… la orden de pago 202699292118
 *   a nombre de A. por USD 1.138,53». Its PDFs carry the details; the text has the order number
 *   and the amount, and the account is the one dollar account the client holds there.
 *
 * A mail of either subject that does not read as described throws: a changed template must
 * fail the step, not drop a wire.
 */

export type WireMail = { message_id: string; sent_at_chile: string; subject: string; text: string };

/** BIC prefixes (bank + country) of the banks the client's accounts are in. */
const BANK_BY_BIC: [RegExp, string][] = [
  [/^BSCHCL/, "santander"],
  [/^BCHICL/, "bancochile"],
  [/^BSCLCL/, "security"],
];

function bankForBic(bic: string): string | null {
  return BANK_BY_BIC.find(([re]) => re.test(bic))?.[1] ?? null;
}

/** MT103 amounts: digits, comma decimal, no grouping («1138,53»). */
function parseSwiftAmount(raw: string): number {
  const m = /^(\d+),(\d{0,2})$/.exec(raw.trim());
  if (!m) throw new Error(`Unparseable SWIFT amount "${raw}"`);
  return Number(`${m[1]}.${(m[2] ?? "").padEnd(2, "0")}`);
}

/** The text of one tag's field: from its tag to the next tag. */
function field(text: string, tag: string): string | null {
  const re = new RegExp(`(?:^|\\s)${tag}:\\s*(.*?)(?=\\s\\d{2}[A-Z]?:\\s|$)`);
  return re.exec(text)?.[1]?.trim() ?? null;
}

export const SECURITY_WIRE_SUBJECT = /^Env[íi]o de Transferencia\b/i;

export function decodeSecurityWireMail(mail: WireMail): IncomingWireNotice {
  const text = mail.text.replace(/\s+/g, " ");
  if (!/FIN 103\b/.test(text)) throw new Error(`«${mail.subject}» is not an MT103 copy`);
  const f32 = field(text, "32A");
  const value = f32 && /Date\s*:\s*(\d{4})(\d{2})(\d{2})\s+Currency\s*:\s*([A-Z]{3})\s+Amount\s*:\s*([\d,]+)/.exec(f32);
  if (!value) throw new Error(`MT103 copy without a readable 32A field: "${f32 ?? ""}"`);
  const currency = value[4]!.toLowerCase();
  if (currency !== "usd") throw new Error(`MT103 copy in ${value[4]}: only dollar wires are mapped`);
  const f50 = field(text, "50K");
  const ordering = f50 && /^Ordering Customer\s+Account\s*:\s*(\S+)\s+Name\s*:\s*(.+)$/.exec(f50);
  const f57 = field(text, "57A");
  const bic = f57 && /BIC\s*:\s*([A-Z0-9]{8,11})/.exec(f57);
  const f59 = field(text, "59F");
  const beneficiary = f59 && /^Beneficiary Customer\s+Account\s*:\s*(\d+)\s+Name\s*:\s*(.+?)(?:\s+Address\s*:|\s+Country\s*:|$)/.exec(f59);
  if (!beneficiary) throw new Error(`MT103 copy without a readable 59F beneficiary: "${f59 ?? ""}"`);
  const reference = field(text, "20")?.replace(/^Sender's Reference\s+/, "") ?? null;
  const remittance = field(text, "70")?.replace(/^Remittance Information\s+/, "") ?? null;
  return {
    message_id: mail.message_id,
    sent_at_chile: mail.sent_at_chile,
    subject: mail.subject,
    bank: "security",
    reported_by: "sending_bank",
    value_date: `${value[1]}-${value[2]}-${value[3]}`,
    currency: "usd",
    amount: parseSwiftAmount(value[5]!),
    beneficiary: { bank: bic ? bankForBic(bic[1]!) : null, account: beneficiary[1]!, name: beneficiary[2]!.trim() },
    ordering: { name: ordering ? ordering[2]!.trim() : null, account: ordering ? ordering[1]! : null, bank: "security" },
    reference: reference || null,
    remittance: remittance || null,
  };
}

export const SANTANDER_WIRE_SUBJECT = /^AVISO DE LIQUIDACION DE ORDEN DE PAGO RECIBIDA/i;

export function decodeSantanderWireMail(mail: WireMail): IncomingWireNotice {
  const text = mail.text.replace(/\s+/g, " ");
  const m = /orden de pago (\d+) a nombre de .*? por (USD|US\$)\s*([\d.]+(?:,\d{1,2})?)/i.exec(text);
  if (!m) throw new Error(`«${mail.subject}» without its order number and dollar amount: "${text.slice(0, 300)}"`);
  return {
    message_id: mail.message_id,
    sent_at_chile: mail.sent_at_chile,
    subject: mail.subject,
    bank: "santander",
    reported_by: "receiving_bank",
    value_date: mail.sent_at_chile.slice(0, 10),
    currency: "usd",
    amount: parseChileanNumber(m[3]!),
    beneficiary: { bank: "santander", account: null, name: null },
    ordering: { name: null, account: null, bank: null },
    reference: m[1]!,
    remittance: null,
  };
}
