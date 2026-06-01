import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import * as cartolaSinMov from "./cartolaSinMovimientos.js";
import { importSyncCartolaSinMovimientosForMonth } from "./importSyncCartolaSinMovimientos.js";
import * as filePathMod from "./importSyncDocumentFilePath.js";
import { db } from "./db.js";
import { cartolaCashAccountIdOptional } from "./movementBalanceCashAccounts.js";

describe("importSyncCartolaSinMovimientosForMonth", () => {
  it("returns false when cartola has imported movements despite sin-mov PDF banner", () => {
    const vistaId = cartolaCashAccountIdOptional("cuenta_vista");
    if (vistaId == null) return;

    vi.spyOn(cartolaSinMov, "cartolaPdfIndicatesSinMovimientos").mockReturnValue(true);
    vi.spyOn(filePathMod, "loadCartolaParsedPdfJsonEntries").mockReturnValue([
      {
        source_file: "2017-10-31 cartola cuenta vista.pdf",
        period_month: "2017-10",
        period_from: "2016-10-28",
        period_to: "2017-10-31",
        parse_status: "ok",
        movements: [{ occurred_on: "2017-03-15" }],
        cartola_sin_movimientos: false,
      },
    ]);

    const row = db
      .prepare(
        `SELECT source_file, SUM(movement_count) AS total
         FROM checking_cartola_imports
         WHERE account_id = ? AND source_file LIKE '%2017-10-31 cartola cuenta vista%'
         GROUP BY source_file
         LIMIT 1`
      )
      .get(vistaId) as { source_file: string; total: number } | undefined;
    if (!row || Number(row.total) <= 0) return;

    const abs = path.join("/tmp", row.source_file);
    expect(
      importSyncCartolaSinMovimientosForMonth({
        accountId: vistaId,
        documentKind: "cuenta_vista_cartola",
        filePath: abs,
      })
    ).toBe(false);
  });

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
