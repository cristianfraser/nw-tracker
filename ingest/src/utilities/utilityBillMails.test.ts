import { describe, expect, it } from "vitest";
import { utilityBillKind } from "nw-tracker-contracts";
import type { ArchivedMail } from "../email/santanderMailArchive.js";
import { decodeEnelBill, decodeMetrogasBill, utilityBillsFromDecoded, type DecodedUtilityBill } from "./utilityBillMails.js";

const mail = (from: string, subject: string, sent: string, text: string, id = sent): ArchivedMail => ({
  message_id: `<${id}@test>`,
  sent_at_chile: sent,
  from,
  subject,
  text,
});

const ENEL = "no-responder@chile.enel.com";
const METROGAS = "pagoenlinea@emailmetrogas.cl";

/** ENEL's bill mail as staged (HTML text, whitespace collapsed, accented letters dropped). */
function enelText(o: { boleta: string; issued: string; amount: string; due: string; consumption: string; next: string }) {
  return (
    `N° Cliente 123456-7 N° Boleta ${o.boleta} del ${o.issued} Estimado Cliente: La boleta del suministro ubicado en ` +
    `AVD EJEMPLO 123 DP 45, PROVIDENCIA ya est disponible. Con la factura digital tienes toda la informaci n a tu alcance. ` +
    `¿Cu nto debo pagar? $ ${o.amount} Fecha de vencimiento ${o.due} ¿Cu nto he consumido? ${o.consumption} ` +
    `Pr ximo periodo de facturaci n ${o.next} PAGA AQU DESCARGUE SU BOLETA`
  );
}

const enelMail = (sent: string, o: Parameters<typeof enelText>[0], id?: string) =>
  mail(ENEL, "Cuenta Enel de este mes 123456-7", sent, enelText(o), id);

describe("ENEL bill mails", () => {
  it("reads the bill, the kWh and the announced period", () => {
    const d = decodeEnelBill(
      enelMail("2036-10-06 15:31", {
        boleta: "123456789",
        issued: "05-10-2036",
        amount: "38.215",
        due: "21-10-2036",
        consumption: "175 kWh Consumo real Se registr correctamente tu lectura",
        next: "02-10-2036 - 02-11-2036",
      })
    )!;
    expect(d).toMatchObject({
      provider: "enel",
      service: "electricity",
      service_account: "123456-7",
      bill_number: "123456789",
      issued_on: "2036-10-05",
      amount: 38215,
      due_on: "2036-10-21",
      kwh: 175,
      m3: null,
      estimated_reading: false,
      period_from: null,
      next_period: { from: "2036-10-02", to: "2036-11-02" },
    });
  });

  it("reads the accented text too, an estimated reading and a bill that prints none", () => {
    const accented =
      "N° Cliente 123456-7 N° Boleta 1 del 05-01-2036 ¿Cuánto debo pagar? $ 1.234.567 Fecha de vencimiento 20-01-2036 " +
      "¿Cuánto he consumido? 1.204 kWh Consumo estimado Próximo periodo de facturación 02-01-2036 - 02-02-2036";
    expect(decodeEnelBill(mail(ENEL, "Cuenta Enel de este mes 123456-7", "2036-01-06 10:00", accented))).toMatchObject({
      amount: 1234567,
      kwh: 1204,
      estimated_reading: true,
    });
    const none = decodeEnelBill(
      enelMail("2036-02-06 10:00", { boleta: "2", issued: "05-02-2036", amount: "9.000", due: "20-02-2036", consumption: "kWh", next: "-" })
    )!;
    expect(none).toMatchObject({ kwh: null, estimated_reading: null, next_period: null });
  });

  it("decodes marketing from the same sender to null, and throws on a bill it cannot read", () => {
    expect(decodeEnelBill(mail(ENEL, "¡Vuelve! te extrañamos en la Sucursal Virtual", "2036-01-01 10:00", "Hola"))).toBeNull();
    expect(() => decodeEnelBill(mail(ENEL, "Cuenta Enel de este mes 123456-7", "2036-01-01 10:00", "N° Cliente 123456-7 nada más"))).toThrow(
      /N° boleta/
    );
    expect(() =>
      decodeEnelBill(
        enelMail("2036-01-06 10:00", { boleta: "3", issued: "05-01-2036", amount: "1", due: "20-01-2036", consumption: "5 kWh Consumo raro", next: "-" })
      )
    ).toThrow(/unknown reading/);
  });

  it("takes each bill's period from the one its predecessor announced", () => {
    const sep = decodeEnelBill(
      enelMail("2036-09-04 10:00", { boleta: "10", issued: "03-09-2036", amount: "87.640", due: "21-09-2036", consumption: "351 kWh Consumo real", next: "02-09-2036 - 01-10-2036" })
    )!;
    const oct = decodeEnelBill(
      enelMail("2036-10-06 10:00", { boleta: "11", issued: "05-10-2036", amount: "38.215", due: "21-10-2036", consumption: "175 kWh Consumo real", next: "02-10-2036 - 02-11-2036" })
    )!;
    // A bill that prints no next period still has its own from the one before.
    const nov = decodeEnelBill(
      enelMail("2036-11-06 10:00", { boleta: "12", issued: "05-11-2036", amount: "40.000", due: "20-11-2036", consumption: "kWh", next: "-" })
    )!;
    const bills = utilityBillsFromDecoded([nov, sep, oct]);
    const by = (n: string) => bills.find((b) => b.bill_number === n)!;
    expect(by("10")).toMatchObject({ period_from: null, period_to: null });
    expect(by("11")).toMatchObject({ period_from: "2036-09-02", period_to: "2036-10-01" });
    expect(by("12")).toMatchObject({ period_from: "2036-10-02", period_to: "2036-11-02" });
    expect(() => utilityBillKind.payload.parse({ bills })).not.toThrow();
  });

  it("throws when a bill's announced period does not follow its predecessor's", () => {
    const a = decodeEnelBill(
      enelMail("2036-09-04 10:00", { boleta: "20", issued: "03-09-2036", amount: "1", due: "21-09-2036", consumption: "1 kWh Consumo real", next: "02-09-2036 - 01-10-2036" })
    )!;
    const b = decodeEnelBill(
      enelMail("2036-10-06 10:00", { boleta: "21", issued: "05-10-2036", amount: "1", due: "21-10-2036", consumption: "1 kWh Consumo real", next: "15-10-2036 - 15-11-2036" })
    )!;
    expect(() => utilityBillsFromDecoded([a, b])).toThrow(/announces/);
  });
});

const metrogasText = (boleta: string, extra = "") =>
  `Ver en el navegador ¡Tu boleta está disponible! Estimado(a) ESTIMADO(A) CLIENTE, te informamos que ya puedes revisar tu boleta ` +
  `Metrogas correspondiente al último período de facturación. Boleta electrónica N° ${boleta} Número Cliente: 000441000001 ` +
  `Dirección: AVENIDA EJEMPLO 123 PROVIDENCIA SANTIAGO Período de consumo: 23/06/2036 al 24/08/2036 Total a pagar: 39.870 ` +
  `Fecha de vencimiento: 15/09/2036 Metropuntos: 250 ${extra}`;

describe("Metrogas bill mails", () => {
  it("reads the bill and its period; the mail's day stands for the issue day", () => {
    const d = decodeMetrogasBill(mail(METROGAS, "Boleta Metrogas Nro. 0000000012345678", "2036-08-28 21:50", metrogasText("0000000012345678")));
    expect(d).toMatchObject({
      provider: "metrogas",
      service: "gas",
      service_account: "000441000001",
      bill_number: "0000000012345678",
      issued_on: "2036-08-28",
      amount: 39870,
      due_on: "2036-09-15",
      period_from: "2036-06-23",
      period_to: "2036-08-24",
      kwh: null,
      m3: null,
    });
  });

  it("collapses the copies mailed to two addresses, and refuses copies that disagree", () => {
    const one = decodeMetrogasBill(mail(METROGAS, "Boleta Metrogas Nro. 0000000012345678", "2036-08-28 21:50", metrogasText("0000000012345678"), "a"))!;
    const two = decodeMetrogasBill(mail(METROGAS, "Boleta Metrogas Nro. 0000000012345678", "2036-08-28 21:50", metrogasText("0000000012345678", "Disponible"), "b"))!;
    expect(utilityBillsFromDecoded([one, two])).toHaveLength(1);
    const other: DecodedUtilityBill = { ...two, amount: 1 };
    expect(() => utilityBillsFromDecoded([one, other])).toThrow(/two mails state different bills/);
  });

  it("decodes other mails to null and throws when the subject and body disagree", () => {
    expect(decodeMetrogasBill(mail(METROGAS, "Actualiza tus datos", "2036-08-28 21:50", "Hola"))).toBeNull();
    expect(() => decodeMetrogasBill(mail(METROGAS, "Boleta Metrogas Nro. 1", "2036-08-28 21:50", metrogasText("2")))).toThrow(/subject names bill/);
  });
});
