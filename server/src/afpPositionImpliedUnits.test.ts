import { describe, expect, it } from "vitest";
import { db } from "./db.js";
import { getAccountPositionMeta } from "./accountPosition.js";
import { AFP_UNO_CUOTA_SERIES_KEY } from "./afpQuetalmiApi.js";

describe("AFP position units", () => {
  it("uses the cuota ledger even when a stored valuation disagrees (ledger is the truth)", () => {
    const bucket = db
      .prepare(`SELECT id FROM asset_groups WHERE slug = 'afp' OR slug LIKE '%__afp' LIMIT 1`)
      .get() as { id: number } | undefined;
    expect(bucket).toBeTruthy();

    const insAcc = db.prepare(
      `INSERT INTO accounts (asset_group_id, name, notes, exclude_from_group_totals)
       VALUES (?, 'AFP UNO test', 'import:excel|key=afp-test', 0)`
    );
    const r = insAcc.run(bucket!.id);
    const accountId = Number(r.lastInsertRowid);

    const asOf = "2025-01-31";
    const px = 100;

    db.prepare(
      `INSERT INTO fund_unit_daily (series_key, day, unit_value_clp, note)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(series_key, day) DO UPDATE SET
         unit_value_clp = excluded.unit_value_clp,
         note = excluded.note`
    ).run(AFP_UNO_CUOTA_SERIES_KEY, asOf, px, "vitest:px");

    db.prepare(
      `INSERT INTO movements (account_id, amount_clp, occurred_on, note, units_delta)
       VALUES (?, ?, ?, ?, ?)`
    ).run(accountId, 1, asOf, "AFP cotizacion vitest", 500);

    // A disagreeing stored valuation must NOT override the certificate-backed ledger.
    db.prepare(
      `INSERT INTO valuations (account_id, as_of_date, value, units_snapshot)
       VALUES (?, ?, ?, null)
       ON CONFLICT(account_id, as_of_date) DO UPDATE SET value = excluded.value`
    ).run(accountId, asOf, 29300);

    const meta = getAccountPositionMeta(accountId, "afp", { afpCuotasAsOfYmd: asOf });
    expect(meta?.units).toBe(500);
    expect(meta?.afp_override_value_clp).toBe(500 * px);

    db.prepare(`DELETE FROM valuations WHERE account_id = ?`).run(accountId);
    db.prepare(`DELETE FROM accounts WHERE id = ?`).run(accountId);
    db.prepare(`DELETE FROM fund_unit_daily WHERE series_key = ? AND day = ? AND note = 'vitest:px'`).run(
      AFP_UNO_CUOTA_SERIES_KEY,
      asOf
    );
  });
});
