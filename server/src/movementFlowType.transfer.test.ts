import { describe, expect, it } from "vitest";
import { FLOW_KIND_AFP_FUND_SWITCH, movementFlowTypeFromRow, movementFlowTypeLabel } from "./movementFlowType.js";

describe("kind-less transfers are named in their own currency", () => {
  const typeOf = (currency: string, transfer_direction: "out" | "in") =>
    movementFlowTypeFromRow({ signed_clp_delta: 0, flow_kind: null, transfer_direction, currency });

  it("reads a dollar transfer as USD on both sides", () => {
    expect(typeOf("usd", "out")).toBe("withdrawal");
    expect(typeOf("usd", "in")).toBe("deposit");
    const usd = { currency: "usd", counter_currency: null };
    expect(movementFlowTypeLabel(typeOf("usd", "out"), usd)).toBe("Retiro USD");
    expect(movementFlowTypeLabel(typeOf("usd", "in"), usd)).toBe("Depósito USD");
  });

  it("keeps a peso transfer as before", () => {
    expect(typeOf("clp", "out")).toBe("withdrawal");
    expect(typeOf("clp", "in")).toBe("deposit");
  });

  it("names a transfer in any currency by its own code", () => {
    expect(typeOf("eur", "in")).toBe("deposit");
    expect(movementFlowTypeLabel(typeOf("eur", "out"), { currency: "eur", counter_currency: null })).toBe("Retiro EUR");
  });
});

describe("an AFP fund switch is named by its kind on both legs", () => {
  it("reads afp_fund_switch whichever side is viewed, labelled «Traspaso AFP»", () => {
    for (const transfer_direction of ["out", "in"] as const) {
      const type = movementFlowTypeFromRow({
        signed_clp_delta: 0,
        flow_kind: FLOW_KIND_AFP_FUND_SWITCH,
        transfer_direction,
        currency: "clp",
      });
      expect(type).toBe("afp_fund_switch");
      expect(movementFlowTypeLabel(type, { currency: "clp", counter_currency: null })).toBe("Traspaso AFP");
    }
  });
});

describe("labels that name a currency take it from the movement", () => {
  it("builds deposits, withdrawals and purchases from the row's currencies", () => {
    expect(movementFlowTypeLabel("deposit", { currency: "clp", counter_currency: null })).toBe("Depósito CLP");
    expect(movementFlowTypeLabel("withdrawal", { currency: "clp", counter_currency: null })).toBe("Retiro CLP");
    expect(movementFlowTypeLabel("fx_purchase", { currency: "usd", counter_currency: null })).toBe("Compra USD");
    expect(movementFlowTypeLabel("fx_exchange", { currency: "clp", counter_currency: "usd" })).toBe(
      "Compra USD / Venta CLP"
    );
    expect(movementFlowTypeLabel("fx_exchange", { currency: "clp", counter_currency: "eur" })).toBe(
      "Compra EUR / Venta CLP"
    );
  });

  it("refuses a currency purchase without its other currency", () => {
    expect(() => movementFlowTypeLabel("fx_exchange", { currency: "clp", counter_currency: null })).toThrow();
  });
});
