import { afterEach, describe, expect, it } from "vitest";
import { fundSeriesKeyForAccount } from "./accountFundSeriesKey.js";
import { db } from "./db.js";

describe("fundSeriesKeyForAccount", () => {
  const created: number[] = [];
  afterEach(() => {
    for (const id of created.splice(0)) db.prepare(`DELETE FROM accounts WHERE id = ?`).run(id);
  });

  function makeAccount(opts: { importKey: string; notes: string; fundSeriesKey: string | null }): number {
    const group = db.prepare(`SELECT id FROM asset_groups LIMIT 1`).get() as { id: number };
    const id = Number(
      db
        .prepare(
          `INSERT INTO accounts (asset_group_id, name, notes, import_key, fund_series_key)
           VALUES (?, 'Vitest · fund series', ?, ?, ?)`
        )
        .run(group.id, opts.notes, opts.importKey, opts.fundSeriesKey).lastInsertRowid
    );
    created.push(id);
    return id;
  }

  it("reads accounts.fund_series_key", () => {
    const id = makeAccount({
      importKey: "vitest-fund-series|column",
      notes: "Vitest fund",
      fundSeriesKey: "vitest_series",
    });
    expect(fundSeriesKeyForAccount(id)).toBe("vitest_series");
  });

  it("never derives a series from notes when the column is unset", () => {
    // The old fallback resolved this notes string to fintual_risky_norris_apv.
    const id = makeAccount({
      importKey: "vitest-fund-series|no-column",
      notes: "import:excel|key=apv_a",
      fundSeriesKey: null,
    });
    expect(fundSeriesKeyForAccount(id)).toBeNull();
  });
});
