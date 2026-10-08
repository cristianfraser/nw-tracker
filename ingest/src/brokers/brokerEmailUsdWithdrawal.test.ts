import { describe, expect, it } from "vitest";
import { classifyBrokerEmail, nextDayOfMonth, parseFintualDollars, toBrokerNotification } from "./brokerEmail.js";

/** The layout of Fintual's «Retiro en dólares confirmado» (2026-10-05), with synthetic figures. */
const snippet = (net: string, gross: string, fee: string) =>
  `Hola Ana, retiraste US $${net} desde Dólares. Hola Ana Recibirás US $${net} Retiraste desde Dólares US $${gross} ` +
  `Comisión US $${fee} Cuenta 1234567890 del Banco Santander Chile Solicitado el lunes 28 de septiembre a las 19:22 ` +
  `Se pagará el jueves 01 antes de las 18:00 Puedes cancelarlo hasta el miércoles 30 antes de las 18:00 desde la aplicación.`;

const mail = (s: string) => ({
  message_id: "<vitest-usd-withdrawal@test>",
  sender: "hola@fintual.com",
  subject: "Retiro en dólares confirmado",
  snippet: s,
  date: "2099-09-28T22:22:33.000Z",
});

describe("Fintual dollar withdrawal confirmation", () => {
  it("reads the amounts in either grouping", () => {
    expect(parseFintualDollars("1138,53")).toBe(1138.53);
    expect(parseFintualDollars("1,138,53")).toBe(1138.53);
    expect(parseFintualDollars("1.138,53")).toBe(1138.53);
    expect(() => parseFintualDollars("1.138")).toThrow();
  });

  it("finds the pay day in the next month", () => {
    expect(nextDayOfMonth("2099-09-28", 1)).toBe("2099-10-01");
    expect(nextDayOfMonth("2099-09-28", 28)).toBe("2099-09-28");
  });

  it("is a withdrawal request with net, gross, account and pay day", () => {
    const e = classifyBrokerEmail(mail(snippet("2,500,00", "2,510,00", "10,00")));
    expect(e).toMatchObject({
      kind: "withdrawal_requested",
      is_transaction: true,
      is_complete: true,
      amount: 2500,
      gross_amount: 2510,
      currency: "usd",
      destination_account: "1234567890",
      due_on: "2099-10-01",
    });
    expect(toBrokerNotification(e)).toMatchObject({
      kind: "withdrawal_requested",
      amount: 2500,
      gross_amount: 2510,
      destination_account: "1234567890",
      due_on: "2099-10-01",
    });
  });

  it("stays incomplete when the figures do not add up", () => {
    const e = classifyBrokerEmail(mail(snippet("2500,00", "2510,00", "9,00")));
    expect(e.kind).toBe("withdrawal_requested");
    expect(e.is_complete).toBe(false);
    expect(e.amount).toBeNull();
  });

  it("keeps the peso «Pediste retirar» out of the money notifications", () => {
    const e = classifyBrokerEmail({ ...mail(""), subject: "Pediste retirar $100.000" });
    expect(e).toMatchObject({ kind: "withdrawal_requested", is_transaction: false });
  });
});
