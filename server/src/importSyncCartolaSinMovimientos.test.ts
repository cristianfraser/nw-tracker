import { describe, expect, it, vi } from "vitest";
import * as cartolaSinMov from "./cartolaSinMovimientos.js";
import { importSyncCartolaSinMovimientosForMonth } from "./importSyncCartolaSinMovimientos.js";
import * as filePathMod from "./importSyncDocumentFilePath.js";

describe("importSyncCartolaSinMovimientosForMonth", () => {
  it("returns true for parser-flagged sin-mov with zero movements", () => {
    vi.spyOn(cartolaSinMov, "cartolaPdfIndicatesSinMovimientos").mockReturnValue(true);
    vi.spyOn(filePathMod, "loadCartolaParsedPdfJsonEntries").mockReturnValue([
      {
        source_file: "2021-04-30 cartola cuenta vista.pdf",
        period_month: "2021-04",
        parse_status: "ok",
        movements: [],
        cartola_sin_movimientos: true,
      },
    ]);

    expect(
      importSyncCartolaSinMovimientosForMonth({
        accountId: 999_999,
        documentKind: "cuenta_vista_cartola",
        filePath: "/tmp/2021-04-30 cartola cuenta vista.pdf",
      })
    ).toBe(true);
  });

  it("falls back to pdftotext when no DB rows and JSON has zero movements", () => {
    vi.spyOn(filePathMod, "loadCartolaParsedPdfJsonEntries").mockReturnValue([]);
    const peek = vi
      .spyOn(cartolaSinMov, "cartolaPdfIndicatesSinMovimientos")
      .mockReturnValue(true);

    expect(
      importSyncCartolaSinMovimientosForMonth({
        accountId: 999_999,
        documentKind: "cuenta_vista_cartola",
        filePath: "/tmp/2020-01-31 cartola cuenta vista.pdf",
      })
    ).toBe(true);
    expect(peek).toHaveBeenCalledWith("/tmp/2020-01-31 cartola cuenta vista.pdf");
  });
});
