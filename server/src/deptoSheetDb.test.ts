import { describe, expect, it } from "vitest";
import { resolveCfraserCsvDir } from "./cfraserPaths.js";
import {
  loadDeptoDividendosSheetLedgerFromDb,
  loadDeptoDividendosSheetLedgerFromFile,
  replaceDeptoDividendosSheetRowsInDb,
} from "./deptoDividendosLedger.js";
import { deptoDividendosSheetRowCount, loadStoredDeptoSheetRowsFromDb } from "./deptoSheetDb.js";

describe("depto_dividendos_sheet_rows", () => {
  it("round-trips sheet rows through SQLite", () => {
    const fromFile = loadDeptoDividendosSheetLedgerFromFile(resolveCfraserCsvDir());
    if (fromFile.length === 0) return;

    const before = deptoDividendosSheetRowCount();
    // replace() preserves origin=manual rows whose cuota|occurred_on key is not in the
    // file (manual-move-entry model) — the round-trip target is file rows + those.
    const fileKeys = new Set(fromFile.map((r) => `${r.cuota}|${r.occurred_on}`));
    const manualExtra = loadStoredDeptoSheetRowsFromDb().filter(
      (r) =>
        r.origin === "manual" && !fileKeys.has(`${r.sheet.cuota}|${r.sheet.occurred_on}`)
    ).length;
    replaceDeptoDividendosSheetRowsInDb(fromFile);
    expect(deptoDividendosSheetRowCount()).toBe(fromFile.length + manualExtra);

    const fromDb = loadDeptoDividendosSheetLedgerFromDb();
    expect(fromDb.length).toBe(fromFile.length + manualExtra);
    const dbKeys = new Set(fromDb.map((r) => `${r.cuota}|${r.occurred_on}`));
    for (const r of fromFile) {
      expect(dbKeys.has(`${r.cuota}|${r.occurred_on}`)).toBe(true);
    }

    if (before === 0) {
      replaceDeptoDividendosSheetRowsInDb([]);
    }
  });
});
