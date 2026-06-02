import { describe, expect, it } from "vitest";
import { resolveCfraserCsvDir } from "./cfraserPaths.js";
import {
  loadDeptoDividendosSheetLedgerFromDb,
  loadDeptoDividendosSheetLedgerFromFile,
  replaceDeptoDividendosSheetRowsInDb,
} from "./deptoDividendosLedger.js";
import { deptoDividendosSheetRowCount } from "./deptoSheetDb.js";

describe("depto_dividendos_sheet_rows", () => {
  it("round-trips sheet rows through SQLite", () => {
    const fromFile = loadDeptoDividendosSheetLedgerFromFile(resolveCfraserCsvDir());
    if (fromFile.length === 0) return;

    const before = deptoDividendosSheetRowCount();
    replaceDeptoDividendosSheetRowsInDb(fromFile);
    expect(deptoDividendosSheetRowCount()).toBe(fromFile.length);

    const fromDb = loadDeptoDividendosSheetLedgerFromDb();
    expect(fromDb.length).toBe(fromFile.length);
    expect(fromDb[0]?.occurred_on).toBe(fromFile[0]?.occurred_on);

    if (before === 0) {
      replaceDeptoDividendosSheetRowsInDb([]);
    }
  });
});
