import { describe, expect, it } from "vitest";
import {
  ahorroDepositNoteIsForensicFamily,
  groupForensicDepositsByMonth,
  parseCuentaAhorroForensicRows,
  planAhorroDepositMovements,
} from "./cuentaAhorroForensicDeposits.js";

describe("cuenta ahorro forensic deposits", () => {
  it("parses month/amount/funding and books the day at month-end", () => {
    const parsed = parseCuentaAhorroForensicRows([
      ["month", "amount_clp", "funding", "note"],
      ["2017-05", "1591730", "", ""],
      ["2017-05", "53265", "self", "recurring"],
      ["2024-04", "-47800000", "", "artifact"],
    ]);
    expect(parsed).toHaveLength(3);
    expect(parsed[0]).toMatchObject({ month: "2017-05", amount_clp: 1_591_730, funding: null });
    expect(parsed[0]!.occurred_on).toBe("2017-05-31");
    expect(parsed[1]).toMatchObject({ funding: "self", note: "recurring" });
    expect(parsed[2]!.amount_clp).toBe(-47_800_000);
  });

  it("rejects bad month, zero amount, and invalid funding", () => {
    expect(() => parseCuentaAhorroForensicRows([["2017/05", "100", "", ""]])).toThrow(/bad month/);
    expect(() => parseCuentaAhorroForensicRows([["2017-05", "0", "", ""]])).toThrow(/bad amount/);
    expect(() => parseCuentaAhorroForensicRows([["2017-05", "100", "cousin", ""]])).toThrow(/invalid funding/);
  });

  it("suppresses dap_proxy rows entirely (no movement, aggregate dropped)", () => {
    const parsed = parseCuentaAhorroForensicRows([
      ["2024-01", "30014000", "dap_proxy", "in"],
      ["2024-04", "-42161361", "dap_proxy", "out"],
    ]);
    expect(parsed[0]).toMatchObject({ dap_proxy: true, funding: null });
    const byMonth = groupForensicDepositsByMonth(parsed);
    // A month whose only forensic rows are dap_proxy emits nothing — the CSV aggregate is dropped.
    expect(planAhorroDepositMovements("2024-04", -42_161_361, byMonth)).toEqual([]);
    expect(planAhorroDepositMovements("2024-01", 30_014_000, byMonth)).toEqual([]);
  });

  it("emits only the real rows when a month mixes dap_proxy and a genuine deposit", () => {
    const byMonth = groupForensicDepositsByMonth(
      parseCuentaAhorroForensicRows([
        ["2024-05", "30000000", "dap_proxy", "parked"],
        ["2024-05", "500000", "family", "gift"],
      ])
    );
    const planned = planAhorroDepositMovements("2024-05", 30_500_000, byMonth);
    expect(planned).toEqual([{ amount_clp: 500_000, noteTag: "Depósitos|forensic:1|funding=family" }]);
  });

  it("plans individual forensic movements for a covered month (overriding the aggregate)", () => {
    const byMonth = groupForensicDepositsByMonth(
      parseCuentaAhorroForensicRows([
        ["2017-05", "1591730", "", ""],
        ["2017-05", "53265", "self", ""],
        ["2017-05", "1113371", "family", ""],
      ])
    );
    // CSV aggregate for the month is ignored when forensic rows exist.
    const planned = planAhorroDepositMovements("2017-05", 2_758_366, byMonth);
    expect(planned.map((p) => p.amount_clp)).toEqual([1_591_730, 53_265, 1_113_371]);
    expect(planned[0]!.noteTag).toBe("Depósitos|forensic:1");
    expect(planned[1]!.noteTag).toBe("Depósitos|forensic:2|funding=self");
    expect(planned[2]!.noteTag).toBe("Depósitos|forensic:3|funding=family");
  });

  it("falls back to the CSV monthly aggregate for months without forensic detail", () => {
    const byMonth = groupForensicDepositsByMonth([]);
    expect(planAhorroDepositMovements("2020-01", 500_000, byMonth)).toEqual([
      { amount_clp: 500_000, noteTag: "Depósitos" },
    ]);
    // No aggregate and no forensic rows → nothing.
    expect(planAhorroDepositMovements("2020-02", null, byMonth)).toEqual([]);
    expect(planAhorroDepositMovements("2020-03", 0, byMonth)).toEqual([]);
  });

  it("recognises a forensic-family note", () => {
    expect(ahorroDepositNoteIsForensicFamily("import:excel|csv|cash|ahorro-vivienda|Depósitos|forensic:3|funding=family")).toBe(true);
    expect(ahorroDepositNoteIsForensicFamily("import:excel|csv|cash|ahorro-vivienda|Depósitos|forensic:2|funding=self")).toBe(false);
    expect(ahorroDepositNoteIsForensicFamily("import:excel|csv|cash|ahorro-vivienda|Depósitos")).toBe(false);
    expect(ahorroDepositNoteIsForensicFamily(null)).toBe(false);
  });
});
