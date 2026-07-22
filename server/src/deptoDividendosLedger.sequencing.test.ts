import { describe, expect, it } from "vitest";
import {
  assertDeptoPrepagoSequencing,
  deptoCreditoRestanteUfBySnapshotDates,
  deptoLedgerChronoCompare,
  deptoSueciaNetEquityUfBySnapshotDates,
  type DeptoMortgageSheetRow,
} from "./deptoDividendosLedger.js";

/** Minimal ledger row: only the fields the fills and the sequencing assert read. */
function row(
  cuota: string,
  occurred_on: string,
  credito_restante_uf: number | null,
  valor_vivienda_uf: number | null = 5400
): DeptoMortgageSheetRow {
  return {
    cuota,
    occurred_on,
    credito_restante_uf,
    valor_vivienda_uf,
  } as unknown as DeptoMortgageSheetRow;
}

/** Repaired Nov-2024 shape: sequential balances, prepago mid-month between cuotas. */
function sequentialLedger(): DeptoMortgageSheetRow[] {
  return [
    row("pie", "2024-04-04", 3950),
    row("8", "2024-10-11", 3706.9385),
    row("9", "2024-11-11", 3641.2185),
    row("prepago 1", "2024-11-18", 3126.219),
    row("10", "2024-12-11", 3060.2342),
  ];
}

describe("deptoCreditoRestanteUfBySnapshotDates — daily-exact fill", () => {
  it("applies a prepago's balance drop on the prepago's own date", () => {
    const m = deptoCreditoRestanteUfBySnapshotDates(
      ["2024-11-11", "2024-11-17", "2024-11-18", "2024-11-19"],
      sequentialLedger()
    );
    expect(m.get("2024-11-11")).toBe(3641.2185);
    expect(m.get("2024-11-17")).toBe(3641.2185);
    expect(m.get("2024-11-18")).toBe(3126.219);
    expect(m.get("2024-11-19")).toBe(3126.219);
  });

  it("treats the 1st of a month as a real calendar day (no month-end cutoff expansion)", () => {
    const m = deptoCreditoRestanteUfBySnapshotDates(
      ["2024-11-01", "2024-11-02"],
      sequentialLedger()
    );
    // Neither the Nov-11 cuota nor the Nov-18 prepago may leak into Nov-1.
    expect(m.get("2024-11-01")).toBe(3706.9385);
    expect(m.get("2024-11-02")).toBe(3706.9385);
  });

  it("orders same-day prepago+cuota pairs by decreasing balance (later payment wins)", () => {
    // Feb-2025 shape: prepago 2 and cuota 12 share 2025-02-11; the cuota-label sort used
    // to apply "12" before "prepago 2" and end the day at the prepago's earlier balance.
    const ledger = [
      row("11", "2025-02-10", 2993.9834),
      row("prepago 2", "2025-02-11", 2590.6438),
      row("12", "2025-02-11", 2522.4985),
    ];
    const m = deptoCreditoRestanteUfBySnapshotDates(["2025-02-11", "2025-02-12"], ledger);
    expect(m.get("2025-02-11")).toBe(2522.4985);
    expect(m.get("2025-02-12")).toBe(2522.4985);
    const sorted = [...ledger].sort(deptoLedgerChronoCompare).map((r) => r.cuota);
    expect(sorted).toEqual(["11", "prepago 2", "12"]);
  });
});

describe("deptoSueciaNetEquityUfBySnapshotDates — prepago equity on its date", () => {
  it("equity steps up on the prepago date, not on the preceding cuota", () => {
    const m = deptoSueciaNetEquityUfBySnapshotDates(
      ["2024-11-11", "2024-11-17", "2024-11-18"],
      sequentialLedger()
    );
    expect(m.get("2024-11-11")).toBeCloseTo(5400 - 3641.2185, 4);
    expect(m.get("2024-11-17")).toBeCloseTo(5400 - 3641.2185, 4);
    expect(m.get("2024-11-18")).toBeCloseTo(5400 - 3126.219, 4);
  });
});

describe("assertDeptoPrepagoSequencing", () => {
  it("accepts sequential ledgers, incl. grace-period capitalization before the first cuota", () => {
    expect(() => assertDeptoPrepagoSequencing(sequentialLedger())).not.toThrow();
    // Balance rising pie -> first billed cuota is real (capitalized grace interest).
    expect(() =>
      assertDeptoPrepagoSequencing([row("pie", "2024-04-04", 3950), row("4", "2024-06-14", 3958.95)])
    ).not.toThrow();
  });

  it("throws on the pre-repair Nov-2024 shape (prepago balance above its predecessor)", () => {
    const broken = [
      row("8", "2024-10-11", 3706.9385),
      row("9", "2024-11-11", 3126.219),
      row("prepago 1", "2024-11-18", 3191.9385),
    ];
    expect(() => assertDeptoPrepagoSequencing([...broken].sort(deptoLedgerChronoCompare))).toThrow(
      /prepago "prepago 1"/
    );
  });
});
