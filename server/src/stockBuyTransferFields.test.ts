import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { db } from "./db.js";
import { validateMovementCreate, type AccountRow } from "./movementUnitsPolicy.js";

const FIXTURE_USD = "vitest-stockbuy-usd";
const FIXTURE_STOCK = "vitest-stockbuy-stock";

describe("stock_buy transfer field validation + ticker default", () => {
  let usdId = 0;
  let stockId = 0;
  let stockRow: AccountRow;

  beforeAll(() => {
    const stockLeaf = db
      .prepare(`SELECT id, slug FROM asset_groups WHERE slug LIKE 'brokerage_acciones__%' LIMIT 1`)
      .get() as { id: number; slug: string } | undefined;
    const usdLeaf = db
      .prepare(`SELECT id, slug FROM asset_groups WHERE slug LIKE '%__usd' LIMIT 1`)
      .get() as { id: number; slug: string } | undefined;
    if (!stockLeaf || !usdLeaf) return;

    db.prepare(`DELETE FROM accounts WHERE name IN (?, ?)`).run(FIXTURE_USD, FIXTURE_STOCK);
    usdId = Number(
      db.prepare(`INSERT INTO accounts (asset_group_id, name) VALUES (?, ?)`).run(usdLeaf.id, FIXTURE_USD).lastInsertRowid
    );
    stockId = Number(
      db
        .prepare(`INSERT INTO accounts (asset_group_id, name, equity_ticker) VALUES (?, ?, 'VITEST')`)
        .run(stockLeaf.id, FIXTURE_STOCK).lastInsertRowid
    );
    stockRow = { bucket_slug: stockLeaf.slug, group_slug: stockLeaf.slug, equity_ticker: "VITEST" };
  });

  afterAll(() => {
    db.prepare(`DELETE FROM accounts WHERE name IN (?, ?)`).run(FIXTURE_USD, FIXTURE_STOCK);
  });

  it("rejects a stray amount_clp on stock_buy (stale hidden-field value)", () => {
    if (!usdId || !stockId) return;
    const v = validateMovementCreate(
      stockRow,
      {
        occurred_on: "2026-07-01",
        flow_kind: "stock_buy",
        amount_clp: 24.741861, // leftover from a CLP field before switching flow type
        amount_usd: 1346.17,
        units_delta: 24.741861,
        counterpart_account_id: usdId,
        counterpart_role: "from",
      },
      stockId
    );
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.error).toMatch(/amount_clp is not allowed/);
  });

  it("defaults the ticker from the equity account when the client omits it", () => {
    if (!usdId || !stockId) return;
    const v = validateMovementCreate(
      stockRow,
      {
        occurred_on: "2026-07-01",
        flow_kind: "stock_buy",
        amount_usd: 1346.17,
        units_delta: 24.741861,
        counterpart_account_id: usdId,
        counterpart_role: "from",
      },
      stockId
    );
    expect(v.ok).toBe(true);
    if (v.ok && v.mode === "transfer") {
      expect(v.ticker).toBe("VITEST");
      expect(v.amount_clp).toBe(0);
      expect(v.units_delta).toBeCloseTo(24.741861, 6);
    }
  });
});
