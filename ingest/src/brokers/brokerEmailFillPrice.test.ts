import { describe, expect, it } from "vitest";
import { classifyBrokerEmail } from "./brokerEmail.js";

const FINTUAL = "hola@fintual.com";

/** A Fintual fill mail, with synthetic figures. */
function fill(subject: string, snippet: string) {
  return classifyBrokerEmail({ sender: FINTUAL, subject, snippet, date: "2097-11-19T17:49:08Z" });
}

describe("Fintual trade mails carry the fill price", () => {
  it("reads the price of an «Invertiste … acciones de <fund>» buy from the body", () => {
    const buy = fill(
      "Invertiste US $1.000,00 dólares en 10,050251256 acciones de Example Holdings PBC",
      "Invertiste 1.000,00 de tus dólares en Example Holdings PBC Monto invertido US $ 1.000,00 " +
        "Precio de la acción US $ 99,50 Acciones compradas 10,050251256 Comisión US $ 0,00"
    );
    expect(buy).toMatchObject({ kind: "buy", amount: 1000, price: 99.5, fund_name: "Example Holdings PBC" });
    expect(buy.units).toBe("10.050251256");
  });

  it("leaves the price empty when the preview does not carry it", () => {
    const buy = fill("Invertiste US $1,67 dólares en 0,002152366 acciones de State Street SPDR S&P 500 ETF Trust", "");
    expect(buy).toMatchObject({ kind: "buy", amount: 1.67, price: null });
  });

  it("throws on a price that does not explain the trade", () => {
    expect(() =>
      fill(
        "Invertiste US $1.000,00 dólares en 10,050251256 acciones de Example Holdings PBC",
        "Monto invertido US $ 1.000,00 Precio de la acción US $ 9,95 Acciones compradas 10,050251256"
      )
    ).toThrow(/does not make/);
  });
});
