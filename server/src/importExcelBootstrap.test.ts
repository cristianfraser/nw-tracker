import { describe, expect, it } from "vitest";
import { db } from "./db.js";
import { assetGroupIdForImportKind } from "./portfolioGroupTree.js";
import {
  importExcelArgvForceWipe,
  importExcelHasExistingBookData,
  importExcelShouldSheetRebuild,
} from "./importExcelBootstrap.js";

describe("importExcelBootstrap", () => {
  it("detects existing book data from import:excel valuations", () => {
    const had = importExcelHasExistingBookData();
    expect(typeof had).toBe("boolean");
    if (had) {
      expect(importExcelShouldSheetRebuild([])).toBe(false);
    }
  });

  it("--force-wipe always requests sheet rebuild", () => {
    expect(importExcelArgvForceWipe(["node", "script", "--force-wipe"])).toBe(true);
    expect(importExcelShouldSheetRebuild(["node", "script", "--force-wipe"])).toBe(true);
  });

  it("empty import:excel valuation set is not existing book data", () => {
    const note = `import:excel|key=afc-vitest-bootstrap-${Date.now()}`;
    const agId = assetGroupIdForImportKind("afc");
    const ins = db.prepare(
      "INSERT INTO accounts (asset_group_id, name, notes) VALUES (?, ?, ?)"
    );
    const r = ins.run(agId, "AFC vitest bootstrap", note);
    const accountId = Number(r.lastInsertRowid);
    try {
      const before = importExcelHasExistingBookData();
      db.prepare(
        "INSERT INTO valuations (account_id, as_of_date, value_clp) VALUES (?, ?, ?)"
      ).run(accountId, "2099-01-31", 1);
      expect(importExcelHasExistingBookData()).toBe(true);
      db.prepare("DELETE FROM valuations WHERE account_id = ?").run(accountId);
      if (!before) {
        expect(importExcelHasExistingBookData()).toBe(false);
      }
    } finally {
      db.prepare("DELETE FROM accounts WHERE id = ?").run(accountId);
    }
  });
});
