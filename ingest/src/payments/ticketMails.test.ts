import { describe, expect, it } from "vitest";
import { processorReceiptSchema } from "nw-tracker-contracts";
import { TICKET_PROCESSORS } from "./ticketMails.js";

const p = (slug: string) => TICKET_PROCESSORS.find((x) => x.slug === slug)!;
let seq = 0;
const mail = (subject: string, sent: string, text: string) => ({
  message_id: `<${sent}-${++seq}@test>`,
  sent_at_chile: sent,
  from: "noreply@example.test",
  subject,
  text,
});
const valid = <T>(r: T) => {
  expect(processorReceiptSchema.safeParse(r).success).toBe(true);
  return r;
};

describe("PuntoTicket", () => {
  const puntoticket = p("puntoticket");
  const event = (items: string, subtotal: string, total: string) =>
    `Mail de Confirmación, número de orden: 11112222 Estimado Ana Pérez Su orden de compra ha finalizado con éxito! Resumen de la compra Orden de Compra 11112222 Nombre Ana Pérez Email ana@example.test Fecha 01-03-2035 Hora 18:40 Resumen del evento Evento Banda Ejemplo en Vivo Lugar Teatro Prueba Fecha 15-03-2035 Hora 21:00 Item Descripción Precio ${items} SUB-TOTAL $${subtotal} DESPACHO $0 TOTAL $${total} Despacho E-Ticket Entrada digital`;

  it("reads an event's order", () => {
    const r = valid(puntoticket.decode(mail("Comprobante de Compra - Orden: 11112222", "2035-03-01 18:41", event("1 GENERAL $20.000 2 GENERAL $20.000", "40.000", "40.000")))!);
    expect(r).toMatchObject({
      processor: "puntoticket",
      payee: { name: "PuntoTicket" },
      amount: 40000,
      currency: "clp",
      paid_at_chile: "2035-03-01 18:40",
      order_ref: "11112222",
      concept: "2 × GENERAL",
      event: { name: "Banda Ejemplo en Vivo", starts_on: "2035-03-15", starts_at: "21:00", ends_on: null, venue: "Teatro Prueba" },
    });
  });

  it("reads an add-on bought apart, with no event", () => {
    const text =
      "Número de Orden:11113333 Estimado Ana Pérez: Su orden de compra ha finalizado con éxito. Fecha: 02-03-2035 Nombre: Ana Pérez Email: ana@example.test Item Descripción Precio 001 Estacionamiento General $ 9.000 Subtotal $ 9.000 Despacho o Retiro $ 0 Total $ 9.000 Despacho E-Ticket";
    const r = valid(puntoticket.decode(mail("Comprobante de Compra - Orden: 11113333", "2035-03-02 10:05", text))!);
    expect(r).toMatchObject({ amount: 9000, paid_at_chile: "2035-03-02 10:05", concept: "Estacionamiento General", event: null });
  });

  it("skips a free order", () => {
    expect(puntoticket.decode(mail("Comprobante de Compra - Orden: 1", "2035-03-03 10:00", event("1 GALERIA $0", "0", "0")))).toBeNull();
  });

  it("throws when the items do not add up", () => {
    expect(() =>
      puntoticket.decode(mail("Comprobante de Compra - Orden: 2", "2035-03-03 10:00", event("1 GENERAL $20.000", "25.000", "25.000")))
    ).toThrow(/items 20000 ≠ subtotal 25000/);
  });

  it("does not ask for the e-ticket invitations", () => {
    expect(puntoticket.wantSubject("Este es su e-Ticket para Banda Ejemplo - Número de Orden: 1")).toBe(false);
  });
});

describe("Toliv", () => {
  const toliv = p("toliv");

  it("reads the older layout, with the place", () => {
    const text =
      "Tus entradas para FIESTA PRUEBA están aquí Ana, Ticket #555 Detalles del evento Nombre: FIESTA PRUEBA Fecha: 31 de Enero 2035 23:00hrs Dirección: Calle Uno #10, Recoleta Lugar: CLUB UNO Detalles del pago Medio de pago: Mercadopago Tickets totales: 1 Fecha de pago: 1 de Febrero 2035 01:40:09hrs Monto tickets: $10.000 CLP Monto comisión: $1.190 CLP Monto total: $11.190 CLP Muchas gracias";
    const r = valid(toliv.decode(mail("Tus tickets para FIESTA PRUEBA", "2035-02-01 01:40", text))!);
    expect(r).toMatchObject({
      processor: "toliv",
      amount: 11190,
      paid_at_chile: "2035-02-01 01:40",
      order_ref: "555",
      payment_method: "Mercadopago",
      event: { name: "FIESTA PRUEBA", starts_on: "2035-01-31", starts_at: "23:00", venue: "CLUB UNO" },
    });
  });

  it("reads the current layout; a blank address is no venue", () => {
    const text =
      "ENTRADA CONFIRMADA - NOCHE UNO ¡Estás dentro, Ana! Tu entrada para NOCHE UNO está lista Fecha: 11 de Diciembre 2035 18:00hrs Dirección: # , Santiago Detalles del pago Medio de pago: Webpay Fecha de pago: 31 de Octubre 2035 02:54:24hrs Monto tickets: $15.000 CLP Monto comisión: $1.785 CLP Monto total: $16.785 CLP Ver mis tickets";
    const r = valid(toliv.decode(mail("Tus tickets para NOCHE UNO", "2035-10-31 02:54", text))!);
    expect(r).toMatchObject({ amount: 16785, event: { name: "NOCHE UNO", starts_on: "2035-12-11", venue: null } });
  });

  it("skips a ticket given for free", () => {
    const text = "Tu entrada para Club Uno está aquí Amig@s ID Ticket: #1 Fecha: 31 de Enero 2035 23:00hrs Dirección: Calle Dos #1 , Recoleta Una vez en el evento";
    expect(toliv.decode(mail("Tu ticket para Club Uno", "2035-01-31 13:00", text))).toBeNull();
  });

  it("throws when the fee does not add up", () => {
    const text =
      "Fecha: 11 de Diciembre 2035 18:00hrs Detalles del pago Fecha de pago: 31 de Octubre 2035 02:54:24hrs Monto tickets: $15.000 CLP Monto comisión: $1.000 CLP Monto total: $16.785 CLP";
    expect(() => toliv.decode(mail("Tus tickets para NOCHE UNO", "2035-10-31 02:54", text))).toThrow(/comisión/);
  });
});

describe("Ticketmaster", () => {
  it("reads a Chilean order, the year taken from the mail", () => {
    const text =
      "Ana, tu compra se ha realizado con éxito. Banda Uno - Sala Prueba Esta es la confirmación de tu compra. Resumen de compra Orden #13420000 Jueves 25 de Octubre General - Preventa $ 30.000 Otros costos Cargo por servicio $ 4.500 Total $ 34.500 Forma de pago: TRANSBANK";
    const r = valid(p("ticketmaster_cl").decode(mail("Tu compra para Banda Uno se ha realizado con éxito", "2035-10-20 20:57", text))!);
    expect(r).toMatchObject({
      processor: "ticketmaster_cl",
      amount: 34500,
      order_ref: "13420000",
      concept: "Banda Uno · General - Preventa",
      event: { name: "Banda Uno", starts_on: "2035-10-25", starts_at: null, venue: "Sala Prueba" },
    });
  });

  it("skips a free Chilean order", () => {
    const text =
      "Ana, tu compra se ha realizado con éxito. Concierto - Parque Esta es la confirmación Resumen de compra Orden #1 22/01/2035 20:00 General $ 0 Otros costos Cargo por servicio $ 0 Total $ 0 Forma de pago: Sin cargo";
    expect(p("ticketmaster_cl").decode(mail("Tu compra para Concierto se ha realizado con éxito", "2035-01-14 12:00", text))).toBeNull();
  });

  it("throws on a weekday that does not fit the date", () => {
    const text =
      "Ana, tu compra Resumen de compra Orden #2 Lunes 25 de Octubre General $ 30.000 Otros costos Cargo por servicio $ 0 Total $ 30.000 Forma de pago: TRANSBANK";
    expect(() => p("ticketmaster_cl").decode(mail("Tu compra para Banda Uno se ha realizado con éxito", "2035-10-20 20:57", text))).toThrow(
      /is not a Lunes/
    );
  });

  it("reads a New Zealand order in NZ$", () => {
    const text =
      "Ana, You're In! Order #34-00000/NZL Banda Dos The Hall, Auckland Sat 24 Nov 2035 @ 8:00 pm Your Order 1x Mobile Ticket Payment Summary 1 General Admission NZ $73.20 Order Processing Fees Handling Fee (NZ $5.00) NZ $5.00 Total NZ $79.88 Your Phone is Your Ticket";
    const r = valid(p("ticketmaster_nz").decode(mail("You’re in! Your Banda Dos ticket confirmation", "2035-10-28 21:26", text))!);
    expect(r).toMatchObject({
      amount: 79.88,
      currency: "nzd",
      order_ref: "34-00000/NZL",
      event: { name: "Banda Dos", starts_on: "2035-11-24", starts_at: "20:00", venue: "The Hall, Auckland" },
    });
  });
});

describe("Paylogic", () => {
  it("reads a festival order in euros, with its days", () => {
    const text =
      "Your order is complete! Dear Ana, Your order for Festival Uno 2035 has been successfully processed. Festival Uno 2035 Jul 13, 2035 - Jul 15, 2035 Campo Prueba, Villa Ejemplo Download E-Ticket Order details Order number 99000001 Payment method VISA Status Completed Order summary Item Qty Subtotal (incl. VAT) Weekend Ticket | Regular 1 € 213.59 EUR Locker 1 € 24.15 EUR Subtotal € 237.74 EUR Service fee € 22.71 EUR Total € 260.45 EUR Do you want an invoice?";
    const r = valid(p("paylogic").decode(mail("Confirmation for Festival Uno 2035 - Order 99000001", "2034-12-03 20:13", text))!);
    expect(r).toMatchObject({
      processor: "paylogic",
      amount: 260.45,
      currency: "eur",
      order_ref: "99000001",
      payment_method: "VISA",
      concept: "Festival Uno 2035 · Weekend Ticket | Regular · Locker",
      event: { name: "Festival Uno 2035", starts_on: "2035-07-13", ends_on: "2035-07-15", venue: "Campo Prueba, Villa Ejemplo" },
    });
  });
});

describe("AI Tickets", () => {
  it("reads an order", () => {
    const text =
      "¡Gracias por tu compra, ana! Tu compra para Noche #2 ha sido procesada con éxito. Detalles del Evento Evento: Noche #2 Fecha: viernes, 12 de octubre de 2035 a las 22:00 hrs Lugar: Calle Tres 5, Santiago Detalles de tu Orden N° Orden: d1848fe6-0000-4601-ac44-b6a228c538bf Fecha de compra: martes, 9 de octubre de 2035, 20:52 Tipo de entrada Cantidad Precio unitario Total Preventa 1 $8.000 $8.800 Total pagado: $8.800 Ver tus entradas";
    const r = valid(p("aitickets").decode(mail("🎟️ ¡Aquí están tus entradas para Noche #2!", "2035-10-09 20:54", text))!);
    expect(r).toMatchObject({
      amount: 8800,
      paid_at_chile: "2035-10-09 20:52",
      concept: "Noche #2 · Preventa",
      event: { name: "Noche #2", starts_on: "2035-10-12", starts_at: "22:00", venue: "Calle Tres 5, Santiago" },
    });
  });
});

describe("Ticketplus", () => {
  const ticketplus = p("ticketplus");

  it("reads a purchase, which states no amount", () => {
    const text =
      'Ana Pérez, tus tickets para: ☆AÑO NUEVO "LA PRUEBA"☆ Lunes 01 Enero Galpón Uno, Calle Cuatro 426 Puedes acceder a tus entradas directamente';
    const r = valid(ticketplus.decode(mail('Tus tickets para ☆AÑO NUEVO "LA PRUEBA"☆', "2034-12-29 22:07", text))!);
    expect(r).toMatchObject({
      amount: null,
      event: { name: 'AÑO NUEVO "LA PRUEBA"', starts_on: "2035-01-01", venue: "Galpón Uno, Calle Cuatro 426" },
    });
  });

  it("skips courtesy tickets", () => {
    const text = "Cortesías Invitades, tus entradas para: FIESTA - SÁBADO 15 DE JUNIO Avenida Uno 345 Puedes acceder a tus entradas";
    expect(ticketplus.decode(mail("Tus entradas para FIESTA - SÁBADO 15 DE JUNIO", "2035-06-15 23:09", text))).toBeNull();
  });
});
