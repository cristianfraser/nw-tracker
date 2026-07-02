import { describe, expect, it } from "vitest";
import { parseCuentaVistaWebPasteText } from "./cuentaVistaWebPasteParse.js";

describe("parseCuentaVistaWebPasteText", () => {
  it("parses signed 3-field lines (semicolon)", () => {
    const r = parseCuentaVistaWebPasteText(
      "15/06/2026; Traspaso Internet desde Cta.Ct; 5.000\n15/06/2026; Traspaso Internet a Cta. Cte.; -5.000"
    );
    expect(r.errors).toEqual([]);
    expect(r.movements).toEqual([
      {
        occurred_on: "2026-06-15",
        description: "Traspaso Internet desde Cta.Ct",
        amount_clp: 5000,
        document_no: "",
      },
      {
        occurred_on: "2026-06-15",
        description: "Traspaso Internet a Cta. Cte.",
        amount_clp: -5000,
        document_no: "",
      },
    ]);
  });

  it("parses 4-field cargo/abono lines (tab)", () => {
    const r = parseCuentaVistaWebPasteText(
      "15-06-2026\tTraspaso Internet a Cta. Cte.\t$5.000\t\n2026-06-15\tTraspaso Internet desde Cta.Ct\t\t5.000"
    );
    expect(r.errors).toEqual([]);
    expect(r.movements.map((m) => m.amount_clp)).toEqual([-5000, 5000]);
    expect(r.movements.every((m) => m.occurred_on === "2026-06-15")).toBe(true);
  });

  it("extracts leading document number from description", () => {
    const r = parseCuentaVistaWebPasteText("15/06/2026; 1206262 Traspaso Internet a Cta. Cte.; -5.000");
    expect(r.movements[0]?.document_no).toBe("1206262");
  });

  it("dedupes identical lines within one paste", () => {
    const line = "15/06/2026; Traspaso Internet a Cta. Cte.; -5.000";
    const r = parseCuentaVistaWebPasteText(`${line}\n${line}`);
    expect(r.movements).toHaveLength(1);
    expect(r.errors).toEqual([]);
  });

  it("rejects dates without year, zero amounts, ambiguous cargo/abono, and wrong field counts", () => {
    const r = parseCuentaVistaWebPasteText(
      [
        "15/06; Sin año; -5.000",
        "15/06/2026; Monto cero; 0",
        "15/06/2026; Ambos montos; 5.000; 5.000",
        "15/06/2026; Ningún monto; ;",
        "solo un campo",
        "15/06/2026; Sin monto",
      ].join("\n")
    );
    expect(r.movements).toEqual([]);
    expect(r.errors).toHaveLength(6);
  });

  it("skips blank lines", () => {
    const r = parseCuentaVistaWebPasteText("\n\n15/06/2026; Abono; 1.000\n\n");
    expect(r.movements).toHaveLength(1);
    expect(r.errors).toEqual([]);
  });
});
