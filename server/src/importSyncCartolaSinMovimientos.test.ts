import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { db } from "./db.js";
import { importSyncCartolaSinMovimientosForMonth } from "./importSyncCartolaSinMovimientos.js";
import * as filePathMod from "./importSyncDocumentFilePath.js";

const EMPTY_FILE = "vitest-sinmov 2021-05-31 cartola cuenta vista.pdf";
const LISTED_FILE = "vitest-sinmov 2021-06-30 cartola cuenta vista.pdf";

let accountId = 0;

beforeAll(() => {
  const bucket = db
    .prepare(`SELECT id FROM asset_groups WHERE slug = 'cash_eqs__cuenta_vista' LIMIT 1`)
    .get() as { id: number } | undefined;
  if (!bucket) throw new Error("cuenta_vista asset group not found");
  accountId = Number(
    db
      .prepare(
        `INSERT INTO accounts (asset_group_id, name, notes)
         VALUES (?, 'Vitest · sin movimientos', 'vitest:import-sync-sin-mov')`
      )
      .run(bucket.id).lastInsertRowid
  );
  const insert = db.prepare(
    `INSERT INTO checking_cartola_imports (account_id, period_month, source_file, movement_count)
     VALUES (?, ?, ?, ?)`
  );
  insert.run(accountId, "2021-05", EMPTY_FILE, 0);
  insert.run(accountId, "2021-06", LISTED_FILE, 3);
});

afterAll(() => {
  db.prepare(`DELETE FROM checking_cartola_imports WHERE account_id = ?`).run(accountId);
  db.prepare(`DELETE FROM accounts WHERE id = ?`).run(accountId);
});

function sinMov(file: string, id = accountId): boolean {
  return importSyncCartolaSinMovimientosForMonth({
    accountId: id,
    documentKind: "cuenta_vista_cartola",
    filePath: `/nonexistent/${file}`,
  });
}

describe("importSyncCartolaSinMovimientosForMonth", () => {
  it("reads an imported cartola that listed no movements as sin movimientos", () => {
    expect(sinMov(EMPTY_FILE)).toBe(true);
  });

  it("reads an imported cartola that listed movements as having them, whatever the parser flagged", () => {
    vi.spyOn(filePathMod, "loadCartolaParsedPdfJsonEntries").mockReturnValue([
      {
        source_file: LISTED_FILE,
        period_month: "2021-06",
        parse_status: "ok",
        movements: [],
        cartola_sin_movimientos: true,
      },
    ]);
    expect(sinMov(LISTED_FILE)).toBe(false);
  });

  it("falls back to the parser's banner flag for a cartola with no import row", () => {
    vi.spyOn(filePathMod, "loadCartolaParsedPdfJsonEntries").mockReturnValue([
      {
        source_file: "vitest-sinmov 2021-04-30 cartola cuenta vista.pdf",
        period_month: "2021-04",
        parse_status: "ok",
        movements: [],
        cartola_sin_movimientos: true,
      },
    ]);
    expect(sinMov("vitest-sinmov 2021-04-30 cartola cuenta vista.pdf", 999_999)).toBe(true);
  });
});
