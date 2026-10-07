import { describe, expect, it } from "vitest";
import { decodeBancoChileTransferMail } from "./transferMails.js";

/** Both layouts as the archive stages them (HTML flattened to text); people and numbers invented. */
const CURRENT = {
  message_id: "<current@test>",
  sent_at_chile: "2030-10-07 11:02",
  subject: "Transferencias de Fondos de Juan Pablo Perez Soto",
  text:
    "Estimado(a) Ana Maria Rojas Le informamos que Juan Pablo Perez Soto le ha transferido $29.597 , el día 07 de " +
    "octubre de 2030. El detalle puede revisarlo a continuación Datos de la Transferencia Rut 11.111.111-1 Cuenta " +
    "12345678 Banco Banco Santander Fecha 07/10/2030 Monto $29.597 ID TEF_IPE0000000000 Mensaje seguro auto Sigue " +
    "estos consejos para evitar fraudes: - Nunca te llamaremos…",
};

const OLD = {
  message_id: "<old@test>",
  sent_at_chile: "2030-01-09 10:09",
  subject: "Aviso de transferencia de fondos",
  text:
    "Comprobante de transferencia electrónica de fondos Estimado(a): Ana Maria Rojas Te informamos que nuestro(a) " +
    "cliente Juan Pablo Perez ha efectuado una transferencia de fondos a tu cuenta con el siguiente detalle: Datos de " +
    "cuenta Fecha 09/01/2030 Asunto almuerzo Datos de destinatario Nombre y Apellido Ana Maria Rojas Rut 11111111-1 " +
    "Email ana@example.com Banco Banco Santander Cuenta destino Cuenta Corriente 00-001-23456-78 Monto $66.800 " +
    "Número de comprobante TEFMBCO0000 Fecha y Hora: miércoles 09 de enero de 2030 10:09 Si tienes dudas…",
};

describe("decodeBancoChileTransferMail", () => {
  it("reads the current layout: sender named, the recipient's Rut and account, the message", () => {
    expect(decodeBancoChileTransferMail(CURRENT)).toEqual({
      message_id: "<current@test>",
      sent_at_chile: "2030-10-07 11:02",
      subject: CURRENT.subject,
      kind: "incoming",
      date: "2030-10-07",
      amount: 29597,
      from: { name: "Juan Pablo Perez Soto", rut: null, bank: "Banco de Chile", account_type: null, account_number: null, email: null },
      to: {
        name: "Ana Maria Rojas",
        rut: "11.111.111-1",
        bank: "Banco Santander",
        account_type: null,
        account_number: "12345678",
        email: null,
      },
      comment: "seguro auto",
      scheduled: false,
    });
  });

  it("reads the 2024 «Aviso» layout", () => {
    expect(decodeBancoChileTransferMail(OLD)).toMatchObject({
      kind: "incoming",
      date: "2030-01-09",
      amount: 66800,
      from: { name: "Juan Pablo Perez", bank: "Banco de Chile" },
      to: { rut: "11111111-1", email: "ana@example.com", account_type: "Cuenta Corriente", account_number: "00-001-23456-78" },
      comment: "almuerzo",
    });
  });

  it("leaves a mail without a message comment as null, and other subjects alone", () => {
    const bare = { ...CURRENT, text: CURRENT.text.replace("Mensaje seguro auto Sigue", "Mensaje Sigue") };
    expect(decodeBancoChileTransferMail(bare)?.comment).toBeNull();
    expect(decodeBancoChileTransferMail({ ...CURRENT, subject: "Tu clave fue cambiada" })).toBeNull();
  });

  it("throws on a transfer mail it cannot read, or whose two amounts disagree", () => {
    expect(() => decodeBancoChileTransferMail({ ...CURRENT, text: "Estimado(a) …" })).toThrow(/no sender/);
    expect(() =>
      decodeBancoChileTransferMail({ ...CURRENT, text: CURRENT.text.replace("Monto $29.597", "Monto $29.598") })
    ).toThrow(/amounts disagree/);
  });
});
