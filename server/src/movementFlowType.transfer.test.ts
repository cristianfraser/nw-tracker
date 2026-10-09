import { describe, expect, it } from "vitest";
import { movementFlowTypeFromRow, movementFlowTypeLabel } from "./movementFlowType.js";

describe("kind-less transfers are named in their own currency", () => {
  const typeOf = (currency: string, transfer_direction: "out" | "in") =>
    movementFlowTypeFromRow({ signed_clp_delta: 0, flow_kind: null, transfer_direction, currency });

  it("reads a dollar transfer as USD on both sides", () => {
    expect(typeOf("usd", "out")).toBe("withdrawal_usd");
    expect(typeOf("usd", "in")).toBe("deposit_usd");
    expect(movementFlowTypeLabel(typeOf("usd", "out"))).toBe("Retiro USD");
    expect(movementFlowTypeLabel(typeOf("usd", "in"))).toBe("Depósito USD");
  });

  it("keeps a peso transfer as before", () => {
    expect(typeOf("clp", "out")).toBe("withdrawal_clp");
    expect(typeOf("clp", "in")).toBe("deposit_clp");
  });

  it("refuses a currency it has no name for", () => {
    expect(() => typeOf("eur", "in")).toThrow(/eur/);
  });
});
