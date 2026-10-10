import { processorReceiptSchema } from "nw-tracker-contracts";
import { describe, expect, it } from "vitest";
import { DESPEGAR_PROCESSORS } from "./despegarMails.js";

const despegar = DESPEGAR_PROCESSORS.find((p) => p.slug === "despegar")!;
const mail = (subject: string, sent: string, text: string) => ({
  message_id: `<${sent}@test>`,
  sent_at_chile: sent,
  from: "noreply@despegar.com",
  subject,
  text,
});

/** The 2019 layout, accents lost as the archive's text loses them. */
const flightMail = (payment: string, split: boolean, breakdown: string, total: string) =>
  `Ac� est� tu voucher Es hora de festejar! Nro. reserva 9876543210 ¡Genial! Ya tienes tu vuelo a Ciudad Sur. Tu voucher est� adjunto. Vuelo Ciudad Norte - Ciudad Sur Detalle de pago Tarjeta ${payment} ${
    split ? "En el resumen de tu tarjeta recibir�s el total desglosado en un cargo correspondiente a Aerolinea Ficticia SA y otros correspondientes a Despegar " : ""
  }${breakdown} TOTAL $ ${total} Puedes encontrar la factura de Despegar.com ingresando en Mis Viajes . INFORMACI N IMPORTANTE PARA TU VIAJE Sobre tu vuelo Vuelo Ciudad Norte - Ciudad Sur Ida y vuelta, 2 adultos IDA 3 de febrero Aerolinea Ficticia SA NRT 23:02 Directo SUR 00:43 Duraci�n 01:41 VUELTA 14 de febrero Aerolinea Ficticia SA SUR 01:33 Directo NRT 03:19 Anticipaci�n para llegar al aeropuerto`;

describe("Despegar purchase mails", () => {
  it("splits a flight into the airline's charge and Despegar's own", () => {
    const r = despegar.decode(
      mail(
        "¡Genial! Tu viaje está confirmado",
        "2036-12-22 00:05",
        flightMail(
          "Master Banco Ficticio terminada en 0000 1 pago de $95.400",
          true,
          "Vuelo para 2 personas $ 60.000 Impuestos y tasas $ 30.000 Cargos $ 5.400",
          "95.400"
        )
      )
    )!;
    expect(processorReceiptSchema.parse(r)).toEqual({
      message_id: "<2036-12-22 00:05@test>",
      sent_at_chile: "2036-12-22 00:05",
      processor: "despegar",
      payee: { name: "Despegar", rut: null, email: null },
      amount: 95400,
      currency: "clp",
      paid_at_chile: "2036-12-22 00:05",
      order_ref: "9876543210",
      // The itinerary prints no year: the first such date after the mail.
      concept: "Vuelo Ciudad Norte ⇄ Ciudad Sur 2037-02-03 → 2037-02-14 · 2 adultos · Aerolinea Ficticia SA",
      statement_descriptor: null,
      payment_method: "Mastercard Banco Ficticio",
      installments: null,
      charges: [
        { amount: 90000, installments: null },
        { amount: 5400, installments: null },
      ],
    });
  });

  it("keeps one charge in cuotas when the mail does not split the payment", () => {
    const r = despegar.decode(
      mail(
        "¡Genial! Tu viaje está confirmado",
        "2036-03-10 12:00",
        flightMail("Visa Banco Ficticio terminada en 0000 3 cuotas de $30.000", false, "Vuelo para 2 personas $ 70.000 Impuestos y tasas $ 20.000", "90.000")
      )
    )!;
    expect(processorReceiptSchema.parse(r)).toMatchObject({
      amount: 90000,
      installments: 3,
      charges: null,
      payment_method: "Visa Banco Ficticio",
      concept: "Vuelo Ciudad Norte ⇄ Ciudad Sur 2037-02-03 → 2037-02-14 · 2 adultos · Aerolinea Ficticia SA",
    });
  });

  it("names a booking with no flight block by what the mail says was bought", () => {
    const r = despegar.decode(
      mail(
        "¡Genial! Tu reserva está confirmada",
        "2036-05-01 10:00",
        "Nro. reserva 1234567 ¡Genial! Ya tienes tu hotel en Ciudad Sur. Detalle de pago Tarjeta Visa Banco Ficticio terminada en 0000 1 pago de $120.000 Alojamiento 3 noches $ 120.000 TOTAL $ 120.000 Mis Viajes"
      )
    )!;
    expect(processorReceiptSchema.parse(r)).toMatchObject({ amount: 120000, order_ref: "1234567", concept: "Hotel en Ciudad Sur", charges: null, installments: null });
  });

  it("reads every other Despegar mail as no purchase", () => {
    expect(despegar.wantSubject("Tu web check-in ya está habilitado ✈️")).toBe(false);
    expect(despegar.decode(mail("¡Ahora podemos viajar juntos!", "2036-01-05 18:19", "Activa tu cuenta"))).toBeNull();
    expect(despegar.decode(mail("Se actualizó tu itinerario.", "2036-01-16 15:51", "Reserva 9876543210 Solicitud RS-1"))).toBeNull();
  });

  it("throws on a confirmation it cannot read", () => {
    expect(() => despegar.decode(mail("¡Genial! Tu viaje está confirmado", "2036-12-22 00:05", "Nro. reserva 9876543210 Tu voucher está adjunto"))).toThrow(
      /2036-12-22 00:05 «¡Genial! Tu viaje está confirmado»: no payment/
    );
    expect(() =>
      despegar.decode(
        mail(
          "¡Genial! Tu viaje está confirmado",
          "2036-12-22 00:05",
          flightMail("Master Banco Ficticio terminada en 0000 1 pago de $95.400", true, "Vuelo para 2 personas $ 60.000 Cargos $ 5.400", "95.400")
        )
      )
    ).toThrow(/breakdown adds up to \$65400/);
    expect(() =>
      despegar.decode(
        mail(
          "¡Genial! Tu viaje está confirmado",
          "2036-12-22 00:05",
          flightMail("Master Banco Ficticio terminada en 0000 3 cuotas de $31.800", true, "Vuelo para 2 personas $ 60.000 Impuestos y tasas $ 30.000 Cargos $ 5.400", "95.400")
        )
      )
    ).toThrow(/which charge is in cuotas/);
  });
});
