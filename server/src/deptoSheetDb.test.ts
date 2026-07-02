import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "./db.js";
import { resolveCfraserCsvDir } from "./cfraserPaths.js";
import {
  loadDeptoDividendosSheetLedgerFromDb,
  loadDeptoDividendosSheetLedgerFromFile,
  replaceDeptoDividendosSheetRowsInDb,
} from "./deptoDividendosLedger.js";
import { deptoDividendosSheetRowCount, loadStoredDeptoSheetRowsFromDb } from "./deptoSheetDb.js";

describe("depto_dividendos_sheet_rows", () => {
  // Snapshot/restore the staging table — this test writes REAL CSV rows and must not
  // leave them in the shared test DB (synthetic-fixtures policy).
  let saved: { sort_order: number; cuota: string; occurred_on: string; row_json: string }[] = [];
  beforeAll(() => {
    saved = db
      .prepare(`SELECT sort_order, cuota, occurred_on, row_json FROM depto_dividendos_sheet_rows`)
      .all() as typeof saved;
  });
  afterAll(() => {
    db.prepare(`DELETE FROM depto_dividendos_sheet_rows`).run();
    const ins = db.prepare(
      `INSERT INTO depto_dividendos_sheet_rows (sort_order, cuota, occurred_on, row_json)
       VALUES (?, ?, ?, ?)`
    );
    for (const r of saved) ins.run(r.sort_order, r.cuota, r.occurred_on, r.row_json);
  });

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
