import { describe, expect, it } from "vitest";
import { everyCardVisited, otherCurrencyTab, statementCallCurrency, unlistedCardsWithDebt } from "./cards.js";
import { TEXT } from "./routes.js";

describe("otherCurrencyTab", () => {
  it("answers a CLP view with the Dólares tab and a USD view with the Pesos tab", () => {
    expect(otherCurrencyTab("CLP")).toMatchObject({ currency: "USD", label: TEXT.currencyUsd, name: "Dólares" });
    expect(otherCurrencyTab("USD")).toMatchObject({ currency: "CLP", label: TEXT.currencyClp, name: "Pesos" });
  });

  it("reads the bank's casing and padding, never guesses an unknown currency", () => {
    expect(otherCurrencyTab(" clp ")?.currency).toBe("USD");
    expect(otherCurrencyTab("usd")?.currency).toBe("CLP");
    expect(otherCurrencyTab(null)).toBeNull();
    expect(otherCurrencyTab("")).toBeNull();
    expect(otherCurrencyTab("EUR")).toBeNull();
  });

  it("alternates: the other tab of the other tab is the one we started on", () => {
    expect(otherCurrencyTab(otherCurrencyTab("CLP")!.currency)?.currency).toBe("CLP");
  });

  it("the tab labels match the bank's words and nothing else", () => {
    expect(TEXT.currencyUsd.test("Dólares")).toBe(true);
    expect(TEXT.currencyClp.test(" Pesos ")).toBe(true);
    expect(TEXT.currencyClp.test("Pesos chilenos")).toBe(false);
  });
});

describe("statementCallCurrency", () => {
  it("names the national statement Pesos and the international one Dólares", () => {
    expect(statementCallCurrency("estadoCuentaNacional")).toBe("CLP");
    expect(statementCallCurrency("estadoCuentaInternacional")).toBe("USD");
  });

  it("knows neither the PDF endpoint nor anything else", () => {
    expect(statementCallCurrency("estadoDeCuenta")).toBeNull();
    expect(statementCallCurrency("consultaUltimosMovimientos")).toBeNull();
    expect(statementCallCurrency("")).toBeNull();
  });
});

describe("everyCardVisited", () => {
  // Synthetic contract numbers.
  const expected = new Set(["800000000001", "800000000002"]);

  it("is true once every contract the summary lists has a call", () => {
    expect(everyCardVisited(["800000000001", "800000000001", "800000000002"], expected)).toBe(true);
  });

  it("is false while a contract is still unvisited, and a null account never counts", () => {
    expect(everyCardVisited(["800000000001", null], expected)).toBe(false);
    expect(everyCardVisited([], expected)).toBe(false);
  });

  it("is never true without the summary's list — the stuck detection decides then", () => {
    expect(everyCardVisited(["800000000001", "800000000002"], null)).toBe(false);
  });
});

describe("unlistedCardsWithDebt", () => {
  // Synthetic contracts: ·0001 owes pesos, ·0002 owes dollars only, ·0003 owes nothing.
  const row = (contract: string, pan: string, currency: string, utilizado: string) => ({
    NUMEROCONTRATO: contract,
    NUMEROPAN: pan,
    CODIGOMONEDA: currency,
    MONTOUTILIZADO: utilizado,
  });
  const cupos = {
    observedAt: "2030-01-01T01:00:00.000Z",
    rows: [
      row("800000000001", "0000000000000001", "CLP", "000000000500000000"),
      row("800000000001", "0000000000000001", "USD", "000000000000010000"),
      row("800000000002", "0000000000000002", "CLP", "000000000000000000"),
      row("800000000002", "0000000000000002", "USD", "000000000000001500"),
      row("800000000003", "0000000000000003", "CLP", "000000000000000000"),
      row("800000000003", "0000000000000003", "USD", "000000000000000000"),
    ],
  };

  it("names each card with debt that no movements call listed, once, by its plastic", () => {
    expect(unlistedCardsWithDebt(["800000000003", null], cupos)).toEqual(["·0001", "·0002"]);
    expect(unlistedCardsWithDebt(["800000000001"], cupos)).toEqual(["·0002"]);
  });

  it("is empty once every indebted card was listed — a card at zero may stay unlisted", () => {
    expect(unlistedCardsWithDebt(["800000000001", "800000000002"], cupos)).toEqual([]);
  });

  it("is empty without the summary — the stuck detection decides then", () => {
    expect(unlistedCardsWithDebt([], null)).toEqual([]);
  });
});
