import { describe, expect, it } from "vitest";
import { amountFitsCurrency, currencyCodeSchema } from "./schemas.js";
import { bankAccountBalancesKind } from "../kinds/bankAccountBalances.js";
import { bankAccountMovementsKind } from "../kinds/bankAccountMovements.js";

describe("currencyCodeSchema", () => {
  it("takes any lowercase three-letter code, and nothing else", () => {
    for (const code of ["clp", "usd", "eur", "xyz"]) expect(currencyCodeSchema.safeParse(code).success).toBe(true);
    for (const code of ["EUR", "uf", "euro", "", "e1r"]) expect(currencyCodeSchema.safeParse(code).success).toBe(false);
  });

  it("holds pesos whole and any other currency to cents", () => {
    expect(amountFitsCurrency(1500, "clp")).toBe(true);
    expect(amountFitsCurrency(1500.5, "clp")).toBe(false);
    expect(amountFitsCurrency(12.34, "eur")).toBe(true);
    expect(amountFitsCurrency(12.345, "eur")).toBe(false);
  });
});

describe("ingest kinds take a currency beyond pesos and dollars", () => {
  it("bank_account.balances in euros", () => {
    const parsed = bankAccountBalancesKind.payload.safeParse({
      issuer: "santander",
      observed_at: "2026-11-12T10:00:00-03:00",
      accounts: [{ number: "123", product: "checking", currency: "eur", balance: 10.5, label: "Cuenta EUR", status: "VIGENTE" }],
    });
    expect(parsed.success).toBe(true);
  });

  it("bank_account.movements in euros", () => {
    const parsed = bankAccountMovementsKind.payload.safeParse({
      account: { issuer: "santander", product: "checking", currency: "eur", number: "123" },
      movements: [{ date: "2026-11-10", description: "Abono", currency: "eur", amount: 12.5, document_no: null, wire_reference: null }],
      rejected_rows: [],
    });
    expect(parsed.success).toBe(true);
  });
});
