import { describe, expect, it } from "vitest";
import {
  santanderMovementAmountToken,
  santanderMovementDateToIso,
  santanderMovementRowToWebPasteLine,
  santanderMovementsByAccount,
  type SantanderMovementRow,
} from "./santanderCardMovements.js";
import { webPasteAmountClpForDb, webPasteAmountUsdForDb } from "./ccPaymentLines.js";

function row(overrides: Partial<SantanderMovementRow> = {}): SantanderMovementRow {
  return {
    Fecha: "04/08/2026",
    Descripcion: "COMPRA NORMAL",
    Comercio: "VITEST MERCHANT",
    Importe: "29.408",
    DescripcionRubro: null,
    Ciudad: "SANTIAGO",
    TipoBen: "Titular",
    IndicadorDebeHaber: "D",
    ...overrides,
  };
}

describe("santanderMovementDateToIso", () => {
  it("converts dd/mm/yyyy", () => {
    expect(santanderMovementDateToIso("04/08/2026")).toBe("2026-08-04");
  });

  it("throws on an unexpected shape rather than guessing", () => {
    expect(() => santanderMovementDateToIso("2026-08-04")).toThrow(/want dd\/mm\/yyyy/);
  });

  it("throws on a day or month out of range", () => {
    expect(() => santanderMovementDateToIso("32/08/2026")).toThrow(/want dd\/mm\/yyyy/);
    expect(() => santanderMovementDateToIso("04/13/2026")).toThrow(/want dd\/mm\/yyyy/);
  });
});

describe("amount conventions", () => {
  it("reads CLP dot-grouped integers", () => {
    const line = santanderMovementRowToWebPasteLine(row(), "clp");
    expect(line.amount_clp).toBe(-29408);
    expect(line.amount_usd).toBeNull();
  });

  it("reads USD decimal commas", () => {
    const line = santanderMovementRowToWebPasteLine(row({ Importe: "18,52" }), "usd");
    expect(line.amount_usd).toBeCloseTo(-18.52, 2);
  });

  it("signs D as a charge and H as a credit, matching the web UI", () => {
    expect(santanderMovementAmountToken(row(), false)).toBe("-29.408");
    expect(santanderMovementAmountToken(row({ IndicadorDebeHaber: "H" }), false)).toBe("29.408");
  });

  it("throws on an indicator that is neither D nor H", () => {
    expect(() => santanderMovementAmountToken(row({ IndicadorDebeHaber: "X" }), false)).toThrow(/want D or H/);
  });

  /**
   * The end-to-end sign check that matters: a charge must land in the DB as positive debt and a
   * NOTA DE CREDITO as negative, after the Santander-specific inversion in webPasteAmount*ForDb.
   */
  it("stores a charge as positive debt and a credit as negative", () => {
    const charge = santanderMovementRowToWebPasteLine(row(), "clp");
    expect(webPasteAmountClpForDb(charge.amount_clp, charge.merchant, "santander")).toBe(29408);

    const credit = santanderMovementRowToWebPasteLine(
      row({ IndicadorDebeHaber: "H", Descripcion: "NOTA DE CREDITO", Importe: "2,74" }),
      "usd"
    );
    expect(webPasteAmountUsdForDb(credit.amount_usd ?? 0, credit.merchant, "santander")).toBeCloseTo(-2.74, 2);
  });
});

describe("row mapping", () => {
  it("uses Comercio as the merchant and keeps Descripcion as context", () => {
    const line = santanderMovementRowToWebPasteLine(
      row({ Descripcion: "COMPRA NACIONAL POR INTERNET", Comercio: "MP*VITEST" }),
      "clp"
    );
    expect(line.merchant).toBe("MP*VITEST");
    expect(line.raw_line).toContain("COMPRA NACIONAL POR INTERNET");
    expect(line.raw_line).toContain("MP*VITEST");
  });

  it("falls back to Descripcion only when Comercio is absent", () => {
    const line = santanderMovementRowToWebPasteLine(row({ Comercio: null, Descripcion: "PAGO VITEST" }), "clp");
    expect(line.merchant).toBe("PAGO VITEST");
  });
});

describe("santanderMovementsByAccount", () => {
  it("merges a card's CLP and USD slides into one batch", () => {
    const grouped = santanderMovementsByAccount({
      fetchedAt: "2026-08-05T00:00:00.000Z",
      slides: [
        { currency: "CLP", account: "800000000001", rows: [row()] },
        { currency: "USD", account: "800000000001", rows: [row({ Importe: "18,52" })] },
        { currency: "CLP", account: "800000000002", rows: [row()] },
      ],
    });
    expect(grouped).toHaveLength(2);
    expect(grouped[0]!.account).toBe("800000000001");
    expect(grouped[0]!.lines).toHaveLength(2);
    expect(grouped[0]!.lines.map((l) => l.currency)).toEqual(["clp", "usd"]);
    expect(grouped[1]!.lines).toHaveLength(1);
  });

  it("throws on a slide currency it does not recognise", () => {
    expect(() =>
      santanderMovementsByAccount({
        fetchedAt: "",
        slides: [{ currency: "EUR", account: "800000000001", rows: [] }],
      })
    ).toThrow(/want CLP or USD/);
  });
});
