import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { db } from "./db.js";
import { validateMovementCreate, type AccountRow } from "./movementUnitsPolicy.js";

const FIXTURE_USD = "vitest-stockbuy-usd";
const FIXTURE_STOCK = "vitest-stockbuy-stock";
const FIXTURE_CLP = "vitest-stockbuy-clp";
const FIXTURE_STOCK_SN = "vitest-stockbuy-stock-sn";

describe("stock_buy transfer field validation + ticker default", () => {
  let usdId = 0;
  let stockId = 0;
  let clpId = 0;
  let stockSnId = 0;
  let stockRow: AccountRow;
  let stockSnRow: AccountRow;

  beforeAll(() => {
    const stockLeaf = db
      .prepare(`SELECT id, slug FROM asset_groups WHERE slug LIKE 'brokerage_acciones__%' LIMIT 1`)
      .get() as { id: number; slug: string } | undefined;
    const usdLeaf = db
      .prepare(`SELECT id, slug FROM asset_groups WHERE slug LIKE '%__usd' LIMIT 1`)
      .get() as { id: number; slug: string } | undefined;
    const clpLeaf = db
      .prepare(`SELECT id, slug FROM asset_groups WHERE slug LIKE '%__clp' LIMIT 1`)
      .get() as { id: number; slug: string } | undefined;
    if (!stockLeaf || !usdLeaf || !clpLeaf) return;

    db.prepare(`DELETE FROM accounts WHERE name IN (?, ?, ?, ?)`).run(
      FIXTURE_USD,
      FIXTURE_STOCK,
      FIXTURE_CLP,
      FIXTURE_STOCK_SN
    );
    usdId = Number(
      db.prepare(`INSERT INTO accounts (asset_group_id, name) VALUES (?, ?)`).run(usdLeaf.id, FIXTURE_USD).lastInsertRowid
    );
    stockId = Number(
      db
        .prepare(`INSERT INTO accounts (asset_group_id, name, equity_ticker) VALUES (?, ?, 'VITEST')`)
        .run(stockLeaf.id, FIXTURE_STOCK).lastInsertRowid
    );
    clpId = Number(
      db.prepare(`INSERT INTO accounts (asset_group_id, name) VALUES (?, ?)`).run(clpLeaf.id, FIXTURE_CLP).lastInsertRowid
    );
    stockSnId = Number(
      db
        .prepare(`INSERT INTO accounts (asset_group_id, name, equity_ticker) VALUES (?, ?, 'VITEST.SN')`)
        .run(stockLeaf.id, FIXTURE_STOCK_SN).lastInsertRowid
    );
    stockRow = { bucket_slug: stockLeaf.slug, group_slug: stockLeaf.slug, equity_ticker: "VITEST" };
    stockSnRow = { bucket_slug: stockLeaf.slug, group_slug: stockLeaf.slug, equity_ticker: "VITEST.SN" };
  });

  afterAll(() => {
    db.prepare(`DELETE FROM accounts WHERE name IN (?, ?, ?, ?)`).run(
      FIXTURE_USD,
      FIXTURE_STOCK,
      FIXTURE_CLP,
      FIXTURE_STOCK_SN
    );
  });

  it("rejects a stray CLP leg on stock_buy (stale hidden-field value)", () => {
    if (!usdId || !stockId) return;
    const v = validateMovementCreate(
      stockRow,
      {
        occurred_on: "2026-07-01",
        flow_kind: "stock_buy",
        amount: 1346.17,
        currency: "usd",
        counter_amount: 24.741861, // leftover from a CLP field before switching flow type
        counter_currency: "clp",
        units_delta: 24.741861,
        counterpart_account_id: usdId,
        counterpart_role: "from",
      },
      stockId
    );
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.error).toMatch(/CLP amount is not allowed/);
  });

  it("defaults the ticker from the equity account when the client omits it", () => {
    if (!usdId || !stockId) return;
    const v = validateMovementCreate(
      stockRow,
      {
        occurred_on: "2026-07-01",
        flow_kind: "stock_buy",
        amount: 1346.17,
        currency: "usd",
        units_delta: 24.741861,
        counterpart_account_id: usdId,
        counterpart_role: "from",
      },
      stockId
    );
    expect(v.ok).toBe(true);
    if (v.ok && v.mode === "transfer") {
      expect(v.ticker).toBe("VITEST");
      expect(v.amount).toBe(1346.17);
      expect(v.currency).toBe("usd");
      expect(v.counter_amount).toBeNull();
      expect(v.units_delta).toBeCloseTo(24.741861, 6);
    }
  });

  it("accepts a CLP-funded stock_buy for a .SN (CLP-quoted) stock from CLP cash", () => {
    if (!clpId || !stockSnId) return;
    const v = validateMovementCreate(
      stockSnRow,
      {
        occurred_on: "2026-07-03",
        flow_kind: "stock_buy",
        amount: 2_985_000,
        currency: "clp",
        units_delta: 2282,
        counterpart_account_id: clpId,
        counterpart_role: "from",
      },
      stockSnId
    );
    expect(v.ok).toBe(true);
    if (v.ok && v.mode === "transfer") {
      expect(v.ticker).toBe("VITEST.SN");
      expect(v.amount).toBe(2_985_000);
      expect(v.currency).toBe("clp");
      expect(v.counter_amount).toBeNull();
      expect(v.counter_currency).toBeNull();
      expect(v.from_account_id).toBe(clpId);
      expect(v.to_account_id).toBe(stockSnId);
      expect(v.units_delta).toBeCloseTo(2282, 9);
    }
  });

  it("rejects a stray USD leg on a CLP-quoted stock_buy", () => {
    if (!clpId || !stockSnId) return;
    const v = validateMovementCreate(
      stockSnRow,
      {
        occurred_on: "2026-07-03",
        flow_kind: "stock_buy",
        amount: 2_985_000,
        currency: "clp",
        counter_amount: 3210.5,
        counter_currency: "usd",
        units_delta: 2282,
        counterpart_account_id: clpId,
        counterpart_role: "from",
      },
      stockSnId
    );
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.error).toMatch(/USD amount is not allowed/);
  });

  it("rejects a CLP-quoted stock_buy funded from USD cash", () => {
    if (!usdId || !stockSnId) return;
    const v = validateMovementCreate(
      stockSnRow,
      {
        occurred_on: "2026-07-03",
        flow_kind: "stock_buy",
        amount: 2_985_000,
        currency: "clp",
        units_delta: 2282,
        counterpart_account_id: usdId,
        counterpart_role: "from",
      },
      stockSnId
    );
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.error).toMatch(/CLP cash/);
  });

  it("still rejects a USD-quoted stock_buy funded from CLP cash", () => {
    if (!clpId || !stockId) return;
    const v = validateMovementCreate(
      stockRow,
      {
        occurred_on: "2026-07-03",
        flow_kind: "stock_buy",
        amount: 1000,
        currency: "usd",
        units_delta: 2,
        counterpart_account_id: clpId,
        counterpart_role: "from",
      },
      stockId
    );
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.error).toMatch(/USD cash/);
  });

  it("accepts a CLP-quoted stock_sell with proceeds to CLP cash", () => {
    if (!clpId || !stockSnId) return;
    const v = validateMovementCreate(
      stockSnRow,
      {
        occurred_on: "2026-07-03",
        flow_kind: "stock_sell",
        amount: 500_000,
        currency: "clp",
        units_delta: -380,
        counterpart_account_id: clpId,
        counterpart_role: "to",
      },
      stockSnId
    );
    expect(v.ok).toBe(true);
    if (v.ok && v.mode === "transfer") {
      expect(v.from_account_id).toBe(stockSnId);
      expect(v.to_account_id).toBe(clpId);
      expect(v.amount).toBe(500_000);
      expect(v.currency).toBe("clp");
    }
  });
});
