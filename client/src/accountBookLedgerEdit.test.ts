import { describe, expect, it } from "vitest";
import { supportsBookLedgerEdit } from "./accountBookLedgerEdit";

describe("supportsBookLedgerEdit", () => {
  it("returns true for valid schema", () => {
    expect(
      supportsBookLedgerEdit({
        valuations: true,
        movements: { units_delta: "optional" },
      })
    ).toBe(true);
  });

  it("returns false for brokerage movement_create shape", () => {
    expect(
      supportsBookLedgerEdit({
        ledger: "movements",
        units_delta: "optional",
        unit_label: "acciones",
        brokerage_flow_kinds: ["deposit_clp"],
      })
    ).toBe(false);
  });

  it("returns false for null/undefined", () => {
    expect(supportsBookLedgerEdit(null)).toBe(false);
    expect(supportsBookLedgerEdit(undefined)).toBe(false);
  });
});
