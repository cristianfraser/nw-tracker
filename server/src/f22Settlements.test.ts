import { afterEach, describe, expect, it } from "vitest";
import { db } from "./db.js";
import { f22Settlement } from "./f22Settlements.js";
import { buildFlowsCheckingIncomePayload } from "./flowsCheckingInflows.js";
import { listMovementBalanceCashAccountIds } from "./movementBalanceCashAccounts.js";

const NOTE = "vitest-f22-settlement";

describe("F22 settlement", () => {
  afterEach(() => {
    db.prepare(`DELETE FROM f22_settlements WHERE tax_year IN (2098, 2099)`).run();
    db.prepare(`DELETE FROM movements WHERE note = ?`).run(NOTE);
  });

  it("a refund received with its inflation adjustment", () => {
    const account = (db.prepare(`SELECT id FROM accounts ORDER BY id LIMIT 1`).get() as { id: number }).id;
    const mv = Number(
      db.prepare(`INSERT INTO movements (account_id, amount, currency, occurred_on, note) VALUES (?, 1012, 'clp', '2099-05-10', ?)`).run(account, NOTE)
        .lastInsertRowid
    );
    db.prepare(
      `INSERT INTO f22_settlements (tax_year, kind, account_id, movement_id, occurred_on, amount, description) VALUES (2099, 'refund', ?, ?, '2099-05-10', 1012, 'x')`
    ).run(account, mv);
    expect(f22Settlement(2099, { 305: -1000, 87: 1000 })).toMatchObject({
      expected: { kind: "refund", amount: 1000 },
      settled: 1012,
      difference: 12,
    });
  });

  it("an unlinked year shows what the form asked for; no form, nothing", () => {
    expect(f22Settlement(2099, { 305: 500, 91: 520 })).toEqual({ expected: { kind: "payment", amount: 520 }, links: [], settled: 0, difference: null });
    expect(f22Settlement(2099, null)).toBeNull();
  });

  it("a linked card payment whose line is gone fails", () => {
    const account = (db.prepare(`SELECT id FROM accounts ORDER BY id LIMIT 1`).get() as { id: number }).id;
    db.prepare(
      `INSERT INTO f22_settlements (tax_year, kind, account_id, movement_id, occurred_on, amount, description) VALUES (2099, 'payment', ?, NULL, '2099-04-20', 987654, 'x')`
    ).run(account);
    expect(() => f22Settlement(2099, { 305: 987654, 91: 987654 })).toThrow(/no card line of 987654/);
  });

  it("a refund the Tesorería kept for another year's debt settles both years", () => {
    db.prepare(
      `INSERT INTO f22_settlements (tax_year, kind, account_id, movement_id, offset_tax_year, occurred_on, amount, description)
       VALUES (2099, 'offset', NULL, NULL, 2098, '2099-05-14', 1021, 'x')`
    ).run();
    expect(f22Settlement(2099, { 305: -1000, 87: 1000 })).toMatchObject({
      links: [{ kind: "offset_kept", other_tax_year: 2098, account_id: null, amount: 1021 }],
      settled: 1021,
      difference: 21,
    });
    expect(f22Settlement(2098, { 305: 900, 91: 900 })).toMatchObject({
      links: [{ kind: "offset_paid", other_tax_year: 2099 }],
      settled: 1021,
    });
    expect(() => f22Settlement(2098, { 305: -900, 87: 900 })).toThrow(/pays a debt the filed form does not owe/);
  });

  it("an offset row must name the other year and no account", () => {
    expect(() =>
      db.prepare(
        `INSERT INTO f22_settlements (tax_year, kind, account_id, movement_id, offset_tax_year, occurred_on, amount, description)
         VALUES (2099, 'offset', NULL, NULL, NULL, '2099-05-14', 1, 'x')`
      ).run()
    ).toThrow(/CHECK/);
  });

  it("a refund paid into an account outside checking is income", () => {
    const checking = new Set(listMovementBalanceCashAccountIds());
    const account = (db.prepare(`SELECT id FROM accounts ORDER BY id`).all() as { id: number }[]).find((a) => !checking.has(a.id))!.id;
    const mv = Number(
      db.prepare(`INSERT INTO movements (account_id, amount, currency, occurred_on, note) VALUES (?, 2034, 'clp', '2099-05-31', ?)`).run(account, NOTE)
        .lastInsertRowid
    );
    db.prepare(
      `INSERT INTO f22_settlements (tax_year, kind, account_id, movement_id, occurred_on, amount, description) VALUES (2099, 'refund', ?, ?, '2099-05-31', 2034, 'x')`
    ).run(account, mv);
    expect(buildFlowsCheckingIncomePayload().lines.filter((l) => l.movement_id === mv)).toMatchObject([
      { account_id: account, amount_clp: 2034, received_on: "2099-05-31", description: "F22 AT2099" },
    ]);
  });
});
