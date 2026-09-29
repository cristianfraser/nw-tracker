import { afterEach, describe, expect, it } from "vitest";
import { db } from "./db.js";
import { accountChartInactive, navBucketChartInactive } from "./accountChartInactive.js";
import { isSupersededSantanderCcMaster } from "./ccConsolidatedCards.js";

describe("accountChartInactive", () => {
  it("detects superseded Santander masters excluded from nav", () => {
    const row = db
      .prepare(
        `SELECT id FROM accounts
         WHERE notes IN ('credit_card_master|santander|4111', 'credit_card_master|santander|4112')
         LIMIT 1`
      )
      .get() as { id: number } | undefined;
    if (!row) return;
    expect(isSupersededSantanderCcMaster(row.id)).toBe(true);
  });

  it("CC masters are never tail-inactive", () => {
    const row = db
      .prepare(
        `SELECT id FROM accounts
         WHERE notes = 'credit_card_master|santander|4242'
         LIMIT 1`
      )
      .get() as { id: number } | undefined;
    if (!row) return;
    expect(accountChartInactive(row.id)).toBe(false);
  });

  it("navBucketChartInactive mirrors per-account inactivity", () => {
    expect(navBucketChartInactive([])).toBe(true);
    const active = db
      .prepare(
        `SELECT id FROM accounts
         WHERE notes = 'credit_card_master|santander|4242'
         LIMIT 1`
      )
      .get() as { id: number } | undefined;
    if (!active) return;
    expect(accountChartInactive(active.id)).toBe(false);
    expect(navBucketChartInactive([active.id])).toBe(false);
  });
});

describe("accountChartInactive — ledger cash with no month-end closes", () => {
  const PREFIX = "vitest-chart-inactive-ledger";
  const created: number[] = [];

  afterEach(() => {
    for (const id of created.splice(0)) {
      db.prepare(`DELETE FROM movements WHERE account_id = ?`).run(id);
      db.prepare(`DELETE FROM accounts WHERE id = ?`).run(id);
    }
  });

  /** A cuenta vista holding `deposits` (CLP, single-leg rows dated long ago). */
  function vistaWith(deposits: number[]): number | null {
    const leaf = db
      .prepare(`SELECT id FROM asset_groups WHERE slug = 'cash_eqs__cuenta_vista'`)
      .get() as { id: number } | undefined;
    if (!leaf) return null;
    const id = Number(
      db
        .prepare(`INSERT INTO accounts (asset_group_id, name, import_key) VALUES (?, ?, ?)`)
        .run(leaf.id, "Vitest · vista", `${PREFIX}-${created.length}`).lastInsertRowid
    );
    created.push(id);
    for (const amount of deposits) {
      db.prepare(
        `INSERT INTO movements (account_id, occurred_on, amount, currency, note)
         VALUES (?, '2024-01-15', ?, 'clp', ?)`
      ).run(id, amount, `${PREFIX} row`);
    }
    return id;
  }

  it("is inactive once emptied, active while it holds money", () => {
    const emptied = vistaWith([500_000, -500_000]);
    if (emptied == null) return;
    expect(accountChartInactive(emptied)).toBe(true);
    const holding = vistaWith([500_000]);
    expect(accountChartInactive(holding!)).toBe(false);
  });
});
