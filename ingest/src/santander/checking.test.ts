import { describe, expect, it } from "vitest";
import { isPesoTransactionsCall } from "./checking.js";

// Synthetic: contract numbers that exist nowhere.
const APIGEE_URL =
  "https://openbanking.santander.cl/account_balances_transactions_and_withholdings_retail/v1/current-accounts/transactions";
const TIBCO_URL = "https://api-dsk.santander.cl/perdsk/datosCliente/consultas/mvtosYDeposiDocCtas";

describe("isPesoTransactionsCall", () => {
  it("accepts the peso account's transactions call on either route", () => {
    expect(isPesoTransactionsCall({ url: APIGEE_URL, requestBody: { accountId: "0000012345678", currency: "CLP" } })).toBe(true);
    expect(isPesoTransactionsCall({ url: TIBCO_URL, requestBody: { Entrada: { NumeroCuenta: "12345678", Divisa: "$" } } })).toBe(true);
  });

  it("accepts a body that names no currency — the page opens on the peso account", () => {
    expect(isPesoTransactionsCall({ url: APIGEE_URL, requestBody: { accountId: "0000012345678" } })).toBe(true);
  });

  it("refuses the dollar account's call and every other endpoint", () => {
    expect(isPesoTransactionsCall({ url: APIGEE_URL, requestBody: { accountId: "0000099001122", currency: "USD" } })).toBe(false);
    expect(
      isPesoTransactionsCall({
        url: "https://api-dsk.santander.cl/perdsk/consultaUltimosMovimientos",
        requestBody: { Entrada: { Moneda: "CLP" } },
      }),
    ).toBe(false);
    expect(isPesoTransactionsCall({ url: APIGEE_URL, requestBody: null })).toBe(false);
  });
});
