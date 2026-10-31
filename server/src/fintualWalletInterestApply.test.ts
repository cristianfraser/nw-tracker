import { afterEach, describe, expect, it } from "vitest";
import { brokerMovementsKind, type BrokerMovement } from "nw-tracker-contracts";
import { db } from "./db.js";
import { applyFintualWalletRead } from "./fintualWalletInterestApply.js";

function interest(id: string, day: string, amount: number): BrokerMovement {
  return {
    movement_id: `fintual-cash-interest:${id}`,
    kind: "interest",
    ticker: null,
    occurred_on: day,
    occurred_at: `${day}T20:37:32-03:00`,
    amount,
    currency: "usd",
    units: null,
    price: null,
    commission: null,
    order_id: null,
    title: "Ganancia dólares",
    dividend: null,
    incomplete: null,
  };
}

function read(apply: boolean, movements: BrokerMovement[]) {
  return brokerMovementsKind.payload.parse({ broker: "fintual", apply, read_at: "2097-10-31T00:00:00Z", movements, dividends: null });
}

describe("applyFintualWalletRead", () => {
  const createdAccounts: number[] = [];
  let usd = 0;

  afterEach(() => {
    db.prepare(`DELETE FROM movements WHERE account_id = ? AND occurred_on LIKE '2097-%'`).run(usd);
    for (const id of createdAccounts.splice(0)) db.prepare(`DELETE FROM accounts WHERE id = ?`).run(id);
  });

  function fintualUsd(): number {
    const key = "import:panel|kind=usd|key=fintual_usd";
    const existing = db.prepare(`SELECT id FROM accounts WHERE import_key = ?`).get(key) as { id: number } | undefined;
    if (existing) return (usd = existing.id);
    const group = db.prepare(`SELECT id FROM asset_groups ORDER BY id LIMIT 1`).get() as { id: number };
    db.prepare(
      `INSERT INTO accounts (asset_group_id, name, exclude_from_group_totals, created_at, import_key)
       VALUES (?, 'vitest Fintual USD', 0, datetime('now'), ?)`
    ).run(group.id, key);
    usd = (db.prepare(`SELECT last_insert_rowid() AS id`).get() as { id: number }).id;
    createdAccounts.push(usd);
    return usd;
  }

  const ledger = () =>
    db
      .prepare(`SELECT occurred_on, amount, currency, flow_kind FROM movements WHERE account_id = ? AND occurred_on LIKE '2097-%' ORDER BY occurred_on`)
      .all(usd);

  it("books a credit the ledger lacks as interest on Fintual USD, once", () => {
    fintualUsd();
    const movements = [interest("2", "2097-10-30", 0.4), interest("1", "2097-06-30", 0.02)];
    const report = applyFintualWalletRead(read(false, movements));
    expect(report.movements.map((m) => m.state)).toEqual(["new", "new"]);
    expect(ledger()).toEqual([]);

    const first = applyFintualWalletRead(read(true, movements));
    expect(first).toMatchObject({ inserted: 2, duplicates: 0, problems: [], clean: true });
    expect(ledger()).toEqual([
      { occurred_on: "2097-06-30", amount: 0.02, currency: "usd", flow_kind: "savings_earnings" },
      { occurred_on: "2097-10-30", amount: 0.4, currency: "usd", flow_kind: "savings_earnings" },
    ]);

    const again = applyFintualWalletRead(read(true, movements));
    expect(again).toMatchObject({ inserted: 0, duplicates: 2, problems: [] });
  });

  it("reports a different interest amount on the same day and writes nothing", () => {
    const id = fintualUsd();
    db.prepare(
      `INSERT INTO movements (account_id, amount, currency, occurred_on, note, flow_kind) VALUES (?, 0.39, 'usd', '2097-10-30', 'by hand', 'savings_earnings')`
    ).run(id);
    const result = applyFintualWalletRead(read(true, [interest("2", "2097-10-30", 0.4)]));
    expect(result.movements[0]!.state).toBe("conflict");
    expect(result.problems).toHaveLength(1);
    expect(result.inserted).toBe(0);
  });

  it("the contract refuses anything but interest from Fintual", () => {
    expect(() =>
      brokerMovementsKind.payload.parse({
        broker: "fintual",
        apply: false,
        read_at: "2097-10-31T00:00:00Z",
        movements: [{ ...interest("3", "2097-10-30", 1), kind: "dividend" }],
        dividends: null,
      })
    ).toThrow(/interest movements only/);
  });
});
