/**
 * Banco de Chile's transfer mails to the beneficiary: a Banco de Chile client sent the user money,
 * and the bank mails the recipient. Decoded into the same `TransferNotice` Santander's mails give,
 * always `incoming`. Two layouts, read off every mail since 2024:
 *
 *  - «Transferencias de Fondos de <sender>» (2024 on): «Le informamos que <sender> le ha
 *    transferido $29.597 , el día 07 de octubre de 2026 … Rut 11.111.111-1 Cuenta 12345678 Banco
 *    Banco Santander Fecha 07/10/2026 Monto $29.597 ID TEF_… Mensaje seguro auto Sigue estos…»
 *  - «Aviso de transferencia de fondos» (2024): «nuestro(a) cliente <sender> ha efectuado una
 *    transferencia de fondos a tu cuenta … Fecha 09/01/2024 Asunto 13 palos hoy Datos de
 *    destinatario Nombre y Apellido … Rut 11111111-1 Email … Banco Banco Santander Cuenta destino
 *    Cuenta Corriente 00-000-12345-67 Monto $66.800 Número de comprobante TEF… Fecha y Hora: …»
 *
 * The Rut and account a mail prints are the RECIPIENT's; the sender is named only. Any other
 * subject from this sender decodes to null; a transfer mail missing a field throws.
 */
import type { TransferNotice, TransferParty } from "../santander/transferMails.js";

type ArchivedMail = { message_id: string; sent_at_chile: string; subject: string; text: string };

const SENDER_BANK = "Banco de Chile";

function clean(text: string): string {
  return text.replace(/Â/g, " ").replace(/ /g, " ").replace(/\s+/g, " ").trim();
}

function fail(mail: ArchivedMail, what: string): never {
  throw new Error(`${mail.sent_at_chile} «${mail.subject}»: no ${what}`);
}

function field(text: string, re: RegExp, mail: ArchivedMail, what: string): string {
  const m = re.exec(text);
  if (!m?.[1]?.trim()) fail(mail, what);
  return m[1]!.trim();
}

function pesos(raw: string, mail: ArchivedMail): number {
  const digits = raw.replace(/\./g, "");
  if (!/^\d+$/.test(digits)) throw new Error(`${mail.sent_at_chile} «${mail.subject}»: unreadable amount «${raw}»`);
  return Number(digits);
}

function dmyToIso(raw: string): string {
  const [d, m, y] = raw.split("/");
  return `${y}-${m!.padStart(2, "0")}-${d!.padStart(2, "0")}`;
}

const party = (p: Partial<TransferParty>): TransferParty => ({
  name: null,
  rut: null,
  bank: null,
  account_type: null,
  account_number: null,
  email: null,
  ...p,
});

export function decodeBancoChileTransferMail(mail: ArchivedMail): TransferNotice | null {
  const text = clean(mail.text);
  if (/^Transferencias de Fondos de /i.test(mail.subject)) {
    const sender = field(text, /Le informamos que (.+?) le ha transferido \$/i, mail, "sender");
    const amount = pesos(field(text, /\bMonto \$\s*([\d.]+)/i, mail, "amount"), mail);
    const stated = pesos(field(text, /le ha transferido \$\s*([\d.]+)/i, mail, "amount in the greeting"), mail);
    if (stated !== amount) throw new Error(`${mail.sent_at_chile} «${mail.subject}»: amounts disagree (${stated} vs ${amount})`);
    const comment = /\bMensaje (.*?) Sigue estos consejos/i.exec(text)?.[1]?.trim() || null;
    return {
      message_id: mail.message_id,
      sent_at_chile: mail.sent_at_chile,
      subject: mail.subject,
      kind: "incoming",
      date: dmyToIso(field(text, /\bFecha (\d{1,2}\/\d{1,2}\/\d{4})/i, mail, "date")),
      amount,
      from: party({ name: sender, bank: SENDER_BANK }),
      to: party({
        name: /Estimado\(a\):? (.+?) (?:Le informamos|Te informamos)/i.exec(text)?.[1]?.trim() ?? null,
        rut: field(text, /\bRut ([\d.]+-[\dkK])/i, mail, "recipient Rut"),
        bank: field(text, /\bBanco (.+?) Fecha \d/i, mail, "recipient bank"),
        account_number: field(text, /\bCuenta ([\d-]+)/i, mail, "recipient account"),
      }),
      comment,
      scheduled: false,
    };
  }
  if (/^Aviso de transferencia de fondos/i.test(mail.subject)) {
    const comment = /\bAsunto (.*?) Datos de destinatario/i.exec(text)?.[1]?.trim() || null;
    return {
      message_id: mail.message_id,
      sent_at_chile: mail.sent_at_chile,
      subject: mail.subject,
      kind: "incoming",
      date: dmyToIso(field(text, /Datos de cuenta Fecha (\d{1,2}\/\d{1,2}\/\d{4})/i, mail, "date")),
      amount: pesos(field(text, /\bMonto \$\s*([\d.]+)/i, mail, "amount"), mail),
      from: party({
        name: field(text, /nuestro\(a\) cliente (.+?) ha efectuado una transferencia/i, mail, "sender"),
        bank: SENDER_BANK,
      }),
      to: party({
        name: /Nombre y Apellido (.+?) Rut /i.exec(text)?.[1]?.trim() ?? null,
        rut: field(text, /\bRut ([\d.]+-[\dkK])/i, mail, "recipient Rut"),
        email: /\bEmail (\S+@\S+)/i.exec(text)?.[1] ?? null,
        bank: field(text, /\bBanco (.+?) Cuenta destino/i, mail, "recipient bank"),
        account_type: /Cuenta destino (Cuenta Corriente|Cuenta Vista|Cuenta de Ahorro|Cuenta RUT)/i.exec(text)?.[1] ?? null,
        account_number: field(text, /Cuenta destino (?:Cuenta Corriente|Cuenta Vista|Cuenta de Ahorro|Cuenta RUT) ([\d-]+)/i, mail, "recipient account"),
      }),
      comment,
      scheduled: false,
    };
  }
  return null;
}
