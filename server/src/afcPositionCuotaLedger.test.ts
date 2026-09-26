import { afterAll, describe, expect, it } from "vitest";
import { db } from "./db.js";
import { getAccountPositionMeta } from "./accountPosition.js";
import { accountMarkClpAtYmd } from "./accountMarkClpAtYmd.js";
import { AFC_CIC_SERIES_KEY } from "./afcCicSeries.js";
import { leafAssetGroupIdForKindSlug, leafAssetGroupSlugForKindSlug } from "./assetGroupTree.js";

/**
 * AFC valued as a cuota ledger (Σ units_delta × `afc_cic` valor cuota), the AFP shape — and
 * an `afc` account with no declared series stays on the stored-mark path.
 */
describe("AFC position — cuota ledger", () => {
  const created: number[] = [];
  const asOf = "2099-03-31";
  const px = 4000;

  afterAll(() => {
    for (const id of created) {
      db.prepare(`DELETE FROM movements WHERE account_id = ?`).run(id);
      db.prepare(`DELETE FROM valuations WHERE account_id = ?`).run(id);
      db.prepare(`DELETE FROM accounts WHERE id = ?`).run(id);
    }
    db.prepare(`DELETE FROM fund_unit_daily WHERE series_key = ? AND day = ? AND note = 'vitest:px'`).run(
      AFC_CIC_SERIES_KEY,
      asOf
    );
  });

  function afcGroup(): { id: number; slug: string } {
    return { id: leafAssetGroupIdForKindSlug("afc"), slug: leafAssetGroupSlugForKindSlug("afc") };
  }

  it("values Σ cuotas × valor cuota and ignores a disagreeing stored valuation", () => {
    const g = afcGroup();
    const r = db
      .prepare(
        `INSERT INTO accounts (asset_group_id, name, notes, fund_series_key, exclude_from_group_totals)
         VALUES (?, 'AFC ledger vitest', 'vitest:afc-ledger', ?, 0)`
      )
      .run(g.id, AFC_CIC_SERIES_KEY);
    const accountId = Number(r.lastInsertRowid);
    created.push(accountId);

    db.prepare(
      `INSERT INTO fund_unit_daily (series_key, day, unit_value_clp, note) VALUES (?, ?, ?, 'vitest:px')
       ON CONFLICT(series_key, day) DO UPDATE SET unit_value_clp = excluded.unit_value_clp, note = excluded.note`
    ).run(AFC_CIC_SERIES_KEY, asOf, px);
    db.prepare(
      `INSERT INTO movements (account_id, amount, currency, occurred_on, note, units_delta)
       VALUES (?, ?, 'clp', ?, ?, ?)`
    ).run(accountId, 2_000_000, asOf, "AFC cotizacion vitest", 500);
    db.prepare(
      `INSERT INTO valuations (account_id, as_of_date, value, units_snapshot) VALUES (?, ?, ?, null)`
    ).run(accountId, asOf, 1_234_567);

    const meta = getAccountPositionMeta(accountId, "afc", { afpCuotasAsOfYmd: asOf });
    expect(meta?.ticker).toBe("AFC CIC");
    expect(meta?.units).toBe(500);
    expect(meta?.afp_override_value_clp).toBe(500 * px);
    expect(meta?.afp_override_value_as_of).toBe(asOf);

    // Historical mark reads the same ledger (not the stored 1.xxx.xxx).
    const mark = accountMarkClpAtYmd(accountId, asOf, g.slug);
    expect(mark).toEqual({ value_clp: 500 * px, as_of_date: asOf });
  });

  it("an afc account without a declared series is not modeled in cuotas (stored-mark path)", () => {
    const g = afcGroup();
    const r = db
      .prepare(
        `INSERT INTO accounts (asset_group_id, name, notes, exclude_from_group_totals)
         VALUES (?, 'AFC stored vitest', 'vitest:afc-stored', 0)`
      )
      .run(g.id);
    const accountId = Number(r.lastInsertRowid);
    created.push(accountId);
    db.prepare(
      `INSERT INTO valuations (account_id, as_of_date, value, units_snapshot) VALUES (?, ?, ?, null)`
    ).run(accountId, asOf, 777_000);

    expect(getAccountPositionMeta(accountId, "afc", { afpCuotasAsOfYmd: asOf })).toBeNull();
    const mark = accountMarkClpAtYmd(accountId, asOf, g.slug);
    expect(mark?.value_clp).toBe(777_000);
  });
});
