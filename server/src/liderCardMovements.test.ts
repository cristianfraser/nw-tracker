import { describe, expect, it } from "vitest";
import {
  liderMovementAmountClp,
  liderMovementDateToIso,
  liderMovementRowToWebPasteLine,
  liderMovementsToWebPasteLines,
} from "./liderCardMovements.js";
import { webPasteAmountClpForDb } from "./ccPaymentLines.js";

/**
 * The Lider «últimos movimientos» CSV drop, adapted to web-paste lines. Rows are real shapes from
 * the 2026-08-05 export.
 */
describe("liderCardMovements", () => {
  it("converts a charge row, preserving BCI's sign convention through to the DB", () => {
    const line = liderMovementRowToWebPasteLine({
      fecha: "2026-08-03",
      descripcion: "EXPRESS FICTICIA 2., SANTIAGO",
      cuotas: "",
      monto: "9080",
      detectado: "2026-08-05",
    });
    expect(line).toMatchObject({
      transaction_date: "2026-08-03",
      merchant: "EXPRESS FICTICIA 2., SANTIAGO",
      amount_clp: 9080,
      amount_usd: null,
      currency: "clp",
    });
    // BCI charges stay positive in the DB (unlike Santander, whose web sign is inverted).
    expect(webPasteAmountClpForDb(line.amount_clp, line.merchant, "BCI")).toBe(9080);
  });

  it("keeps a PAGO negative", () => {
    const line = liderMovementRowToWebPasteLine({
      fecha: "2026-07-30",
      descripcion: "PAGO",
      cuotas: "",
      monto: "-1129477",
      detectado: "2026-08-05",
    });
    expect(line.amount_clp).toBe(-1129477);
    expect(webPasteAmountClpForDb(line.amount_clp, line.merchant, "BCI")).toBe(-1129477);
  });

  it("rejects unmapped shapes instead of guessing", () => {
    expect(() => liderMovementDateToIso("03/08/2026")).toThrow(/want YYYY-MM-DD/);
    expect(() => liderMovementAmountClp("9.080")).toThrow(/plain integer pesos/);
    expect(() => liderMovementAmountClp("")).toThrow(/plain integer pesos/);
    // The cuotas column has only ever been empty — a value means the format needs mapping.
    expect(() =>
      liderMovementRowToWebPasteLine({
        fecha: "2026-08-03",
        descripcion: "TIENDA",
        cuotas: "3",
        monto: "9080",
      })
    ).toThrow(/cuotas="3"/);
    expect(() =>
      liderMovementsToWebPasteLines([{ fecha: "2026-08-03", monto: "10" } as Record<string, string>])
    ).toThrow(/missing required column\(s\): descripcion/);
  });

  it("converts a whole export", () => {
    const lines = liderMovementsToWebPasteLines([
      { fecha: "2026-08-03", descripcion: "EXPRESS FICTICIA 2., SANTIAGO", cuotas: "", monto: "9080", detectado: "2026-08-05" },
      { fecha: "2026-07-30", descripcion: "PAGO", cuotas: "", monto: "-1129477", detectado: "2026-08-05" },
    ]);
    expect(lines).toHaveLength(2);
    expect(lines.map((l) => l.currency)).toEqual(["clp", "clp"]);
  });
});
