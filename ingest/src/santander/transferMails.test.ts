import { describe, expect, it } from "vitest";
import { decodeTransferMail } from "./transferMails.js";

const mail = (subject: string, sent: string, text: string) => ({ message_id: `<${sent}@test>`, sent_at_chile: sent, subject, text });

describe("decodeTransferMail", () => {
  it("reads the 2016–2018 «Label : value» receipt", () => {
    const n = decodeTransferMail(
      mail(
        "Transferencia de fondos",
        "2036-01-10 19:29",
        "Aviso de Transferencia de fondos 10/01/2036 Estimado PERSONA UNO: Te enviamos el detalle de la transferencia que acabas de hacer. Monto de transferencia: 36.000.- ORIGEN Tipo de cuenta : Cuenta Corriente Cuenta N : 0-000-11-11111-1 Rut : 11.111.111-1 Nombre : PERSONA UNO DESTINO Banco : Banco Estado Tipo de cuenta : Cuenta N : 22222222 Rut : 22.222.222-2 Nombre : PERSONA DOS Mail : dos@example.com Comentario : arreglo Si tienes cualquier duda, sólo llama"
      )
    )!;
    expect(n).toMatchObject({ kind: "outgoing", date: "2036-01-10", amount: 36000, comment: "arreglo" });
    expect(n.from).toMatchObject({ account_number: "0-000-11-11111-1", account_type: "Cuenta Corriente" });
    expect(n.to).toEqual({ name: "PERSONA DOS", rut: "22.222.222-2", bank: "Banco Estado", account_type: null, account_number: "22222222", email: "dos@example.com" });
  });

  it("reads the layout that prints two labels and then both values", () => {
    const n = decodeTransferMail(
      mail(
        "Transferencia a terceros",
        "2036-07-05 13:50",
        "Comprobante Transferencia de fondos Tu transferencia de fondos ha sido realizada con exito. Estimado (a) PERSONA UNO : Te enviamos el detalle de la transferencia realizada con fecha 05/07/2036: Â Monto de Transferencia: $800.000 Â ORIGEN Tipo Cuenta: Cuenta Nro.: Cuenta Vista 0-070-11-11111-1 Rut: Nombre: 11.111.111-1 PERSONA UNO Comentario: Â Â DESTINO Banco: Tipo de cuenta: Banco Santander Cuenta Corriente Cuenta Nro.: Rut: 0-000-33-33333-3 33.333.333-3 Nombre: Mail: INMOBILIARIA TRES S.A. pagos@example.com Â Â Si tienes cualquier duda"
      )
    )!;
    expect(n).toMatchObject({ kind: "outgoing", amount: 800000, date: "2036-07-05" });
    expect(n.from).toMatchObject({ account_number: "0-070-11-11111-1", account_type: "Cuenta Vista", rut: "11.111.111-1", name: "PERSONA UNO" });
    expect(n.to).toEqual({
      name: "INMOBILIARIA TRES S.A.", rut: "33.333.333-3", bank: "Banco Santander", account_type: "Cuenta Corriente",
      account_number: "0-000-33-33333-3", email: "pagos@example.com",
    });
  });

  it("reads the 2024 «Datos de origen / Datos de destino» receipt", () => {
    const n = decodeTransferMail(
      mail(
        "Comprobante Transferencia de fondos",
        "2036-01-02 13:13",
        "Comprobante Transferencia de fondos Estimado(a) PERSONA UNO: Te enviamos el detalle de la transferencia realizada el 02/01/2036. Monto transferido $ 90.000 Datos de origen Tipo de cuenta Cuenta Corriente Nº de cuenta 0-000-11-11111-1 RUT 11.111.111-1 Nombre PERSONA UNO Comentario null Datos de destino Nombre PERSONA CUATRO RUT 4.444.444-4 Banco Banco Crédito e Inversiones Tipo de cuenta Cuenta Corriente Nº de cuenta 0-000-44-44444-4 E-mail cuatro@example.com Antes de imprimir este correo"
      )
    )!;
    expect(n).toMatchObject({ kind: "outgoing", amount: 90000, comment: null });
    expect(n.to).toEqual({
      name: "PERSONA CUATRO", rut: "4.444.444-4", bank: "Banco Crédito e Inversiones", account_type: "Cuenta Corriente",
      account_number: "0-000-44-44444-4", email: "cuatro@example.com",
    });
  });

  it("reads an incoming notice, old and new, and an employer's payroll wire", () => {
    const old = decodeTransferMail(
      mail(
        "Transferencia de fondos",
        "2036-01-26 20:39",
        "Comprobante Transferencia de fondos Estimado (a) PERSONA UNO : Te informamos que con fecha 26/01/2036, nuestro cliente PERSONA CINCO ha instruido una transferencia de fondos a su cuenta con el siguiente detalle: Â Banco de destino: Cuenta de destino Nro.: Banco Santander 0-000-11-11111-1 Rut destinatario: Monto de la Operacion: 11.111.111-1 200.000 Comentario: Â $$ Â Â "
      )
    )!;
    expect(old).toMatchObject({ kind: "incoming", amount: 200000, from: { name: "PERSONA CINCO" }, to: { account_number: "0-000-11-11111-1" } });
    const recent = decodeTransferMail(
      mail(
        "Transferencia de fondos",
        "2036-04-22 22:45",
        "Comprobante Transferencia de fondos Estimado(a) PERSONA UNO: Te informamos que, con fecha 22/04/2036, nuestro cliente PERSONA CINCO realizó una transferencia a tu cuenta. Este es el detalle: Monto transferido $ 50.000 Datos de destino Nombre PERSONA UNO RUT 11.111.111-1 Banco Banco Santander Nº de cuenta 0-000-11-11111-1 Comentario Antes de imprimir"
      )
    )!;
    expect(recent).toMatchObject({ kind: "incoming", amount: 50000, date: "2036-04-22", to: { account_number: "0-000-11-11111-1" } });
    const payroll = decodeTransferMail(
      mail(
        "Aviso de Transferencia de Fondos Nro. 123",
        "2036-09-30 08:45",
        "Aviso de transferencia de fondos - Destinatario Estimados Señores: PERSONA UNO Le informamos, que por instrucción de nuestro cliente EMPRESA SPA hoy 30/09/2036 08:42 hemos realizado una transferencia de fondos hacia su cuenta Nro. 000011111111 del BANCO SANTANDER CHILE por el monto 2.000.000 , moneda PESOS DE CHILE. Adjuntamos información provista por nuestro cliente:Remuneraciones Septiembre Atentamente, Banco Santander Chile"
      )
    )!;
    expect(payroll).toMatchObject({ kind: "incoming", amount: 2000000, from: { name: "EMPRESA SPA" }, comment: "Remuneraciones Septiembre" });
  });

  it("tells a transfer between own products and a scheduling notice apart from a payment", () => {
    const own = decodeTransferMail(
      mail(
        "Aviso de transferencia entre productos",
        "2036-03-01 15:35",
        "Aviso Transferencia entre productos Tu transferencia se ha realizado con éxito. Estimado (a) PERSONA UNO: Te enviamos el detalle de la transferencia que acabas de realizar. Monto de Transferencia: 1.150.000.- ORIGEN Tipo de cuenta: Cuenta Vista Cuenta N : 0-070-11-11111-1 DESTINO Tipo de cuenta: Cuenta Corriente Cuenta N : 0-000-11-11111-1 "
      )
    )!;
    expect(own).toMatchObject({ kind: "between_own_products", amount: 1150000, from: { account_number: "0-070-11-11111-1" }, to: { account_number: "0-000-11-11111-1" } });
    const scheduled = decodeTransferMail(
      mail(
        "Aviso de Transferencias a Fecha",
        "2036-07-31 20:25",
        "Aviso de Agendamiento de Transferencia a Fecha 31 de Julio del 2036 Estimado (a) PERSONA UNO Se ha creado exitosamente el siguiente agendamiento de transferencia a fecha: Monto de transferencia: $ 600.000 .- ORIGEN Tipo de cuenta : Cuenta Corriente Cuenta Nº : 0-000-11-11111-1 Rut : 11.111.111-1 Nombre : PERSONA UNO DESTINO Banco : Banco Santander Cuenta Nº : 0-000-33-33333-3 Rut : 33.333.333-3 Nombre : INMOBILIARIA TRES Mail : pagos@example.com Comentarios : depto DATOS DE AGENDAMIENTO Periodicidad : Mensual"
      )
    )!;
    expect(scheduled).toMatchObject({ kind: "schedule_created", amount: 600000 });
  });

  it("returns null for a mail that is not a transfer, and throws on a transfer it cannot read", () => {
    expect(decodeTransferMail(mail("Compra de divisas", "2036-01-01 10:00", "Comprobante Pago Tarjeta de Credito ..."))).toBeNull();
    expect(() => decodeTransferMail(mail("Transferencia de fondos", "2036-01-01 10:00", "Comprobante Transferencia de fondos sin monto"))).toThrow();
  });
});
