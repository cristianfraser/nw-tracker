import { describe, expect, it } from "vitest";
import { decodeSantanderWireMail, decodeSecurityWireMail } from "./incomingWireMails.js";

/** Banco Security's copy of the MT103, as the mail archiver stages it (synthetic parties). */
const MT103 =
  "Dears Sirs Please find attached copy of message forwarded to WELLS FARGO BANK N.A., by instruction of our customer " +
  "BROKER ADM. S.A., corresponding to payment of your collection order. Please contact the sender for any discrepancy. " +
  "Swift OUTPUT : FIN 103 Single Customer Credit Transfer Sender : BSCLCLRMXXX BANCO SECURITY SANTIAGO - CHILE " +
  "Receiver : PNBPUS3NXNYC WELLS FARGO BANK N.A. NEW YORK,NY - UNITED STATES MUR : 00000000-0000-0000-0000-000000000000 " +
  "-------------------------------------------- 20: Sender's Reference OPS0000001 23B: Bank Operation Code CRED " +
  "32A: Value Date/Currency/Interbank Settled Amount Date : 20991001 Currency: USD Amount : 2500,5 " +
  "50K: Ordering Customer Account : 100000001 Name : BROKER ADM. S. A. CALLE 1 CL/SANTIAGO " +
  "57A: Account With Institution BIC : BSCHCLRMXXX BANCO SANTANDER CHILE SANTIAGO - CHILE " +
  "59F: Beneficiary Customer Account : 1234567890 Name : ANA PEREZ Address : CALLE 2 County/State : Country : CL " +
  "70: Remittance Information /RFB/RETIRO USD 71A: Details Of Charges OUR";

describe("incoming wire mails", () => {
  it("reads Banco Security's MT103 copy", () => {
    expect(
      decodeSecurityWireMail({ message_id: "<m1@test>", sent_at_chile: "2099-10-01 12:30", subject: "Envío de Transferencia", text: MT103 })
    ).toEqual({
      message_id: "<m1@test>",
      sent_at_chile: "2099-10-01 12:30",
      subject: "Envío de Transferencia",
      bank: "security",
      reported_by: "sending_bank",
      value_date: "2099-10-01",
      currency: "usd",
      amount: 2500.5,
      beneficiary: { bank: "santander", account: "1234567890", name: "ANA PEREZ" },
      ordering: { name: "BROKER ADM. S. A. CALLE 1 CL/SANTIAGO", account: "100000001", bank: "security" },
      reference: "OPS0000001",
      remittance: "/RFB/RETIRO USD",
    });
  });

  it("refuses a copy in another currency or another message type", () => {
    const m = { message_id: "<m2@test>", sent_at_chile: "2099-10-01 12:30", subject: "Envío de Transferencia" };
    expect(() => decodeSecurityWireMail({ ...m, text: MT103.replace("Currency: USD", "Currency: EUR") })).toThrow(/only dollar/);
    expect(() => decodeSecurityWireMail({ ...m, text: MT103.replace("FIN 103", "FIN 202") })).toThrow(/not an MT103/);
  });

  it("reads Santander's received payment order notice", () => {
    const text =
      "Estimados Señores: ANA PEREZ Presente. Tenemos el agrado de informar a Ud(s) el envío de la orden de pago " +
      "200000000001 a nombre de A. por USD 2.500,50. En el documento adjunto podrá encontrar más detalles.";
    expect(
      decodeSantanderWireMail({
        message_id: "<m3@test>",
        sent_at_chile: "2099-10-01 13:10",
        subject: "AVISO DE LIQUIDACION DE ORDEN DE PAGO RECIBIDA",
        text,
      })
    ).toMatchObject({
      bank: "santander",
      reported_by: "receiving_bank",
      value_date: "2099-10-01",
      amount: 2500.5,
      beneficiary: { bank: "santander", account: null },
      reference: "200000000001",
    });
  });

  it("throws on a notice it cannot read", () => {
    expect(() =>
      decodeSantanderWireMail({ message_id: "<m4@test>", sent_at_chile: "2099-10-01 13:10", subject: "AVISO DE LIQUIDACION DE ORDEN DE PAGO RECIBIDA", text: "Hola" })
    ).toThrow(/order number/);
  });
});
