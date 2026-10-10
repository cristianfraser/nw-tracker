import { describe, expect, it } from "vitest";
import { LATAM_PROCESSORS } from "./latamMails.js";

const latam = LATAM_PROCESSORS.find((p) => p.slug === "latam")!;
const change = LATAM_PROCESSORS.find((p) => p.slug === "latam_change")!;
const mail = (from: string, subject: string, sent: string, text: string) => ({ message_id: `<${sent}@test>`, sent_at_chile: sent, from, subject, text });

describe("LATAM purchase mails", () => {
  it("reads «Confirmacion de compra» (2018–2021), joining a connection into its journey", () => {
    const r = latam.decode(
      mail(
        "compras@bo.lan.com",
        "Confirmacion de compra",
        "2036-09-02 18:10",
        "Tu código de reserva es: QXZTRA Recuerda hacer tu Check-in … Resumen de tu compra: Pasajeros: ANA PEREZ Precio $ 553.359 (CLP) Itinerario Sábado 21 septiembre 2036 18:50 Santiago de Chile (SCL) 12:35 Madrid (MAD) LA704 Operado por LATAM Airlines Group Economy-G Sólo incluye equipaje de mano Martes 22 octubre 2036 00:55 Madrid (MAD) 05:45 Lima (LIM) LA2485 Operado por LATAM Airlines Peru Economy-O Sólo incluye equipaje de mano 07:45 Lima (LIM) 13:25 Santiago de Chile (SCL) LA635 Operado por LATAM Airlines Group Economy-O Sólo incluye equipaje de mano Si tu equipaje de mano excede … Prepárate para tu viaje"
      )
    )!;
    expect(r).toMatchObject({
      processor: "latam",
      payee: { name: "LATAM Airlines", rut: null, email: null },
      amount: 553359,
      currency: "clp",
      paid_at_chile: "2036-09-02 18:10",
      order_ref: "QXZTRA",
      concept: "SCL → MAD 2036-09-21 · MAD → LIM → SCL 2036-10-22 · ANA PEREZ",
      installments: null,
      charges: null,
    });
  });

  it("reads the English «E-Ticket Confirmation», priced in dollars", () => {
    const r = latam.decode(
      mail(
        "sales@bo.lan.com",
        "E-Ticket Confirmation",
        "2036-02-06 09:01",
        "Your reservation code is: KPLMNO Don't forget web Check-in at LATAM.com … Summary of your purchase: Passengers: Ana Maria Perez Soto Price US$ 698.03 (USD) Get ready for your trip"
      )
    )!;
    expect(r).toMatchObject({ amount: 698.03, currency: "usd", order_ref: "KPLMNO", concept: "Ana Maria Perez Soto" });
  });

  it("reads «Confirmación compra» (2021–2023): a ticket, extras, and a ticket paid partly in miles", () => {
    const ticket = latam.decode(
      mail(
        "info@mail.latam.com",
        "Confirmación compra",
        "2036-10-16 16:45",
        "Santiago De Chile, allá vamos Hola Ana, Ya tenemos todo listo para tu viaje de Salvador De Bahía a Santiago De Chile. Nº de Orden: LA0451111ABCD Con este número podrás administrar tu viaje. Información de compra Tu compra está lista Total $239883.00 Revisa tu viaje"
      )
    )!;
    expect(ticket).toMatchObject({ amount: 239883, currency: "clp", order_ref: "LA0451111ABCD", concept: "Salvador De Bahía → Santiago De Chile" });

    const extras = latam.decode(
      mail(
        "info@mail.latam.com",
        "Confirmación compra",
        "2036-08-31 01:19",
        "Actualizamos tu viaje N° de orden LA0452222EFGH Infomación de Pago El pago de tus adicionales se ha realizado correctamente Total CLP $64288.00 Si necesitas saber más detalles"
      )
    )!;
    expect(extras).toMatchObject({ amount: 64288, order_ref: "LA0452222EFGH", concept: "Adicionales del viaje" });

    const miles = latam.decode(
      mail(
        "info@info.latam.com",
        "Confirmación compra",
        "2036-10-28 21:43",
        "Está listo tu próximo viaje Hola Ana, Ya tenemos todo listo para tu viaje de Santiago De Chile a Auckland. Nº de Orden: LA0453333IJKL Con este número podrás administrar tu viaje. Información de compra Tu canje y compra están listos Total 150000 millas + $82.069 Revisa tu viaje"
      )
    )!;
    expect(miles).toMatchObject({ amount: 82069, concept: "Santiago De Chile → Auckland · + 150000 millas" });
  });

  it("reads «Ya compraste tu viaje a X» (2025 on), city names and airport codes", () => {
    const r = latam.decode(
      mail(
        "info@info.latam.com",
        "Ya compraste tu viaje a Londres",
        "2036-01-20 19:31",
        "Conoce los detalles de tu compra ¡Tu viaje a Londres está listo! Nº de orden: LA0454444MNOP Código de reserva: ABCDEF Gestionar mi viaje Hola Ana, … Itinerario de viaje Vuelo de ida 29 jun 2036 19:00 Santiago de Chile LA706 Vuelo operado por: LATAM Airlines Group Cambio de avión en: Madrid LA1701 Vuelo operado por: Iberia Tiempo de espera: 1 hr 50 min 30 jun 2036 17:15 Londres Vuelo de vuelta 14 jul 2036 21:20 Londres LA8085 Vuelo operado por: LATAM Airlines Brasil Cambio de avión en: Sao Paulo LA715 Vuelo operado por: LATAM Airlines Group Tiempo de espera: 2 hr 10 min 15 jul 2036 10:30 Santiago de Chile Te recomendamos revisar los requisitos de viaje . Lista de pasajeros Ana Perez Soto Administrador del viaje Ana Perez Soto A****@E****.COM Información de pago Total: CLP 1.856.030 Encontrarás adjunto el comprobante de compra."
      )
    )!;
    expect(r).toMatchObject({
      amount: 1856030,
      currency: "clp",
      order_ref: "ABCDEF",
      concept: "Santiago de Chile → Madrid → Londres 2036-06-29 · Londres → Sao Paulo → Santiago de Chile 2036-07-14 · Ana Perez Soto · orden LA0454444MNOP",
    });

    const miles = latam.decode(
      mail(
        "info@info.latam.com",
        "Ya compraste tu viaje a Buenos Aires",
        "2036-07-30 22:04",
        "¡Tu viaje a Buenos Aires está listo! Nº de orden: LA0455555QRST Código de reserva: GHIJKL Gestionar mi viaje … Itinerario de viaje Vuelo de ida 29 ago 2036 11:47 Santiago de Chile (SCL) LA455 29 ago 2036 14:50 Buenos Aires (AEP) Vuelo de vuelta 04 sept 2036 22:30 Buenos Aires (AEP) LA426 04 sept 2036 23:53 Santiago de Chile (SCL) Te recomendamos revisar los requisitos de viaje . Lista de pasajeros Ana Perez Soto Administrador del viaje Ana Perez Soto Información de pago Total: Millas 9.667 + CLP 96.052 Encontrarás adjunto"
      )
    )!;
    expect(miles).toMatchObject({ amount: 96052, order_ref: "GHIJKL", concept: "SCL → AEP 2036-08-29 · AEP → SCL 2036-09-04 · Ana Perez Soto · + 9.667 millas · orden LA0455555QRST" });
  });

  it("decodes a pending reservation, an attachment-only «Informacion de tu compra» and other subjects to null", () => {
    expect(
      latam.decode(
        mail(
          "sales@bo.lan.com",
          "Confirmacion de compra",
          "2036-02-22 11:32",
          "Código de reserva: ABCDEF Itinerario … Información de pago Forma de pago Monto a pagar Pendiente (Reserva) CLP 445.842"
        )
      )
    ).toBeNull();
    expect(
      latam.decode(mail("compras@bo.latam.com", "Informacion de tu compra", "2036-08-16 12:31", "Estimado cliente: Junto con saludarlo, tenemos el agrado de enviarle Informacion de su Compra."))
    ).toBeNull();
    expect(latam.decode(mail("info@info.latam.com", "Aquí está tu tarjeta de embarque", "2036-08-16 12:31", "Tu tarjeta de embarque"))).toBeNull();
  });

  it("throws on a purchase mail it cannot read", () => {
    expect(() =>
      latam.decode(mail("info@info.latam.com", "Ya compraste tu viaje a Lima", "2036-03-01 10:00", "¡Tu viaje a Lima está listo! Nº de orden: LA0456666UVWX Itinerario de viaje Vuelo de ida 01 mar 2036 08:00 Santiago de Chile LA600 Te recomendamos"))
    ).toThrow(/2036-03-01 10:00 «Ya compraste tu viaje a Lima»: no total/);
    expect(() => latam.decode(mail("info@mail.latam.com", "Confirmación compra", "2036-03-01 10:00", "Hola, gracias por tu compra"))).toThrow(/no known purchase layout/);
  });
});

describe("LATAM ticket change mails", () => {
  it("reads the fare difference of «Tu cambio de pasaje está listo.» (2021) and «Tu cambio está listo» (2025)", () => {
    const old = change.decode(
      mail(
        "info@mail.latam.com",
        "Tu cambio de pasaje está listo.",
        "2036-06-03 15:04",
        "Revisa el estado de tu cambio Tu código de reserva es: MNOPQR Este es tu nuevo itinerario Ida A. Merino Benítez Intl. a Barajas Intl. 29/8 30/8 22:30:00 - 17:10:00 Vuelo Directo Vuelta Barajas Intl. a A. Merino Benítez Intl. 8/10 9/10 23:55:00 - 08:25:00 Vuelo Directo Total Pagado: $724 (CLP) Descarga tu Comprobante"
      )
    )!;
    expect(old).toMatchObject({
      processor: "latam_change",
      amount: 724,
      currency: "clp",
      order_ref: "MNOPQR",
      concept: "Cambio de pasaje · A. Merino Benítez Intl. → Barajas Intl. 29/8 · Barajas Intl. → A. Merino Benítez Intl. 8/10",
    });

    const recent = change.decode(
      mail(
        "info@info.latam.com",
        "Tu cambio está listo",
        "2036-06-03 20:10",
        "Está listo tu viaje N° de orden LA0457777YZAB Tu cambio de vuelo fue realizado con éxito. Información pago de cambio El pago de tu cambio se realizó correctamente. Total CLP $182.702 Si necesitas más información"
      )
    )!;
    expect(recent).toMatchObject({ amount: 182702, order_ref: "LA0457777YZAB", concept: "Cambio de pasaje" });
  });

  it("decodes a change that charged nothing to null", () => {
    expect(
      change.decode(mail("info@mail.latam.com", "Tu cambio se realizó con éxito", "2036-08-16 16:46", "Tu cambio de itinerario se realizó con éxito Código de reserva: MNOPQR Santiago de Chile a Madrid 01 sep 02 sep"))
    ).toBeNull();
    expect(change.decode(mail("info@mail.latam.com", "Tu cambio está listo", "2036-08-16 16:46", "N° de orden LA0457777YZAB Total CLP $0"))).toBeNull();
  });

  it("throws on a change whose total it cannot read", () => {
    expect(() => change.decode(mail("info@mail.latam.com", "Tu cambio está listo", "2036-08-16 16:46", "N° de orden LA0457777YZAB Total a pagar: pendiente"))).toThrow(/a total this cannot read/);
  });
});
