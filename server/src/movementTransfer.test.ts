import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { db } from "./db.js";
import {
  isMovementTransferRow,
  signedClpDeltaForAccountMovement,
  signedUsdDeltaForAccountMovement,
  sumClpThroughDate,
  unitsDeltaForAccountMovement,
} from "./movementTransfer.js";

describe("movementTransfer", () => {
  let fromId = 0;
  let toId = 0;

  beforeAll(() => {
    const g = db
      .prepare(`SELECT id FROM asset_groups WHERE slug LIKE '%cuenta_corriente' LIMIT 1`)
      .get() as { id: number } | undefined;
    const g2 = db
      .prepare(`SELECT id FROM asset_groups WHERE slug LIKE '%cuenta_vista' LIMIT 1`)
      .get() as { id: number } | undefined;
    if (!g || !g2) return;
    const ins = db.prepare(`INSERT INTO accounts (asset_group_id, name) VALUES (?, ?)`);
    fromId = Number(ins.run(g.id, "vitest-transfer-from").lastInsertRowid);
    toId = Number(ins.run(g2.id, "vitest-transfer-to").lastInsertRowid);
  });

  afterAll(() => {
    db.prepare(`DELETE FROM movements WHERE note LIKE 'vitest-%'`).run();
    for (const id of [fromId, toId]) {
      if (id) db.prepare(`DELETE FROM accounts WHERE id = ?`).run(id);
    }
  });

  it("detects transfer rows", () => {
    expect(
      isMovementTransferRow({ account_id: null, from_account_id: 1, to_account_id: 2 })
    ).toBe(true);
    expect(isMovementTransferRow({ account_id: 1, from_account_id: null, to_account_id: null })).toBe(
      false
    );
  });

  it("applies CLP transfer deltas", () => {
    const row = {
      account_id: null,
      from_account_id: fromId,
      to_account_id: toId,
      amount: 100_000,
      currency: "clp",
      counter_amount: null,
      counter_currency: null,
      occurred_on: "2026-01-01",
      note: null,
      units_delta: null,
      flow_kind: null,
      ticker: null,
    };
    expect(signedClpDeltaForAccountMovement(row, fromId)).toBe(-100_000);
    expect(signedClpDeltaForAccountMovement(row, toId)).toBe(100_000);
  });

  it("applies USD transfer deltas (stock buy leg skips USD on to_account)", () => {
    const row = {
      account_id: null,
      from_account_id: fromId,
      to_account_id: toId,
      amount: 264.35,
      currency: "usd",
      counter_amount: null,
      counter_currency: null,
      occurred_on: "2026-01-02",
      note: null,
      units_delta: 4,
      flow_kind: "stock_buy",
      ticker: "SPY",
    };
    expect(signedUsdDeltaForAccountMovement(row, fromId)).toBe(-264.35);
    expect(signedUsdDeltaForAccountMovement(row, toId)).toBe(0);
    expect(unitsDeltaForAccountMovement(row, toId)).toBe(4);
    expect(unitsDeltaForAccountMovement(row, fromId)).toBe(0);
  });

  it("stock_buy transfer debits USD from the cash from-leg regardless of provenance notes", () => {
    // The migration:usd-cash zero-debit gate was removed with tranche B (2026-08): every
    // funding wire is a real transfer credit now, so buys must debit the cash ledger for real.
    const row = {
      account_id: null,
      from_account_id: fromId,
      to_account_id: toId,
      amount: 612.36,
      currency: "usd",
      counter_amount: null,
      counter_currency: null,
      occurred_on: "2024-12-10",
      note: "migration:usd-cash|from=85|migration:stock-flow-kind",
      units_delta: 1,
      flow_kind: "stock_buy",
      ticker: "SPY",
    };
    expect(signedUsdDeltaForAccountMovement(row, fromId)).toBe(-612.36);
    expect(signedUsdDeltaForAccountMovement(row, toId)).toBe(0);
  });

  it("single-leg compra credits USD regardless of provenance notes (gates removed with tranche B)", () => {
    const row = {
      account_id: fromId,
      from_account_id: null,
      to_account_id: null,
      // Post-169 a single-leg row carries one native leg (the CHECK forbids a counter pair);
      // the USD leg is the one this flow kind credits.
      amount: 3353.07,
      currency: "usd",
      counter_amount: null,
      counter_currency: null,
      occurred_on: "2026-05-28",
      note: "migration:fx-merge|dep=1448|compra=1449",
      units_delta: null,
      flow_kind: "compra_usd_venta_clp",
      ticker: null,
    };
    expect(signedUsdDeltaForAccountMovement(row, fromId)).toBe(3353.07);
  });

  it("legacy compra_usd rows carrying share units stay off the USD cash ledger", () => {
    const row = {
      account_id: fromId,
      from_account_id: null,
      to_account_id: null,
      amount: 54.35,
      currency: "usd",
      counter_amount: null,
      counter_currency: null,
      occurred_on: "2026-03-03",
      note: null,
      units_delta: 0.5,
      flow_kind: "compra_usd",
      ticker: "SPY",
    };
    expect(signedUsdDeltaForAccountMovement(row, fromId)).toBe(0);
  });

  it("stock_sell transfer debits shares on from_account and credits USD on to_account", () => {
    const row = {
      account_id: null,
      from_account_id: fromId,
      to_account_id: toId,
      amount: 3072.48,
      currency: "usd",
      counter_amount: null,
      counter_currency: null,
      occurred_on: "2026-06-16",
      note: null,
      units_delta: 61.056979521,
      flow_kind: "stock_sell",
      ticker: "OILK",
    };
    expect(unitsDeltaForAccountMovement(row, fromId)).toBeCloseTo(-61.056979521, 8);
    expect(unitsDeltaForAccountMovement(row, toId)).toBe(0);
    expect(signedUsdDeltaForAccountMovement(row, fromId)).toBe(0);
    expect(signedUsdDeltaForAccountMovement(row, toId)).toBe(3072.48);
  });

  it("sums CLP through date with transfer + legacy rows", () => {
    if (!fromId || !toId) return;
    db.prepare(
      `INSERT INTO movements (account_id, amount, currency, occurred_on, note)
       VALUES (?, 50000, 'clp', '2026-03-01', 'vitest-single')`
    ).run(fromId);
    db.prepare(
      `INSERT INTO movements (
         account_id, from_account_id, to_account_id, amount, currency, occurred_on, note
       ) VALUES (NULL, ?, ?, 25000, 'clp', '2026-03-02', 'vitest-transfer')`
    ).run(fromId, toId);

    const fromBal = sumClpThroughDate(fromId, "2026-03-31");
    const toBal = sumClpThroughDate(toId, "2026-03-31");
    expect(fromBal).toBe(25_000);
    expect(toBal).toBe(25_000);

    db.prepare(`DELETE FROM movements WHERE note LIKE 'vitest-%'`).run();
  });
});
