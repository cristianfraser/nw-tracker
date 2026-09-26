import { describe, expect, it } from "vitest";
import { ccCupoSnapshot } from "./creditCardInstallments.js";

const rows = [
  { billing_month: "2027-01", as_of_kind: "manual" as const, balance_total_clp: 0 },
  { billing_month: "2026-09", as_of_kind: "manual" as const, balance_total_clp: 8_513_870 },
  { billing_month: "2026-08", as_of_kind: "statement" as const, balance_total_clp: 11_718_617 },
  { billing_month: "2026-07", as_of_kind: "statement" as const, balance_total_clp: 9_000_000 },
];

describe("ccCupoSnapshot", () => {
  it("reads the open month's balance as used and leaves the configured total minus it", () => {
    expect(ccCupoSnapshot(12_000_000, rows, "2026-09")).toEqual({
      total_clp: 12_000_000,
      used_clp: 8_513_870,
      available_clp: 3_486_130,
      billing_month: "2026-09",
    });
  });

  it("falls back to the latest closed statement when there is no open month (order-independent)", () => {
    const shuffled = [rows[3]!, rows[1]!, rows[0]!, rows[2]!];
    expect(ccCupoSnapshot(12_000_000, shuffled, null)).toEqual({
      total_clp: 12_000_000,
      used_clp: 11_718_617,
      available_clp: 281_383,
      billing_month: "2026-08",
    });
  });

  it("an unconfigured cupo is null, never 0 — available stays unknown", () => {
    expect(ccCupoSnapshot(null, rows, "2026-09")).toEqual({
      total_clp: null,
      used_clp: 8_513_870,
      available_clp: null,
      billing_month: "2026-09",
    });
  });

  it("with no billing rows nothing is used and nothing is available", () => {
    expect(ccCupoSnapshot(12_000_000, [], "2026-09")).toEqual({
      total_clp: 12_000_000,
      used_clp: null,
      available_clp: null,
      billing_month: null,
    });
  });
});
