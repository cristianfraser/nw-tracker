import { describe, expect, it } from "vitest";
import { db } from "./db.js";
import { insertMovement } from "./movementWrites.js";

class Rollback extends Error {}

/** Runs `body` in a transaction that is always rolled back. */
function rolledBack(body: () => void): void {
  try {
    db.transaction(() => {
      body();
      throw new Rollback();
    })();
  } catch (e) {
    if (!(e instanceof Rollback)) throw e;
  }
}

const [a, b] = (db.prepare(`SELECT id FROM accounts ORDER BY id LIMIT 2`).all() as { id: number }[]).map((r) => r.id);
const stored = (id: number) =>
  db
    .prepare(
      `SELECT account_id, from_account_id, to_account_id, amount, currency, counter_amount, counter_currency,
              occurred_on, note, units_delta, counter_units_delta, flow_kind
         FROM movements WHERE id = ?`
    )
    .get(id);
const day = { occurredOn: "2020-01-02" };

describe("insertMovement", () => {
  it("stores a single-leg row with every column it was not given null", () => {
    rolledBack(() => {
      const id = insertMovement({ accountId: a!, amount: -1500, currency: "clp", ...day });
      expect(stored(id)).toEqual({
        account_id: a, from_account_id: null, to_account_id: null, amount: -1500, currency: "clp",
        counter_amount: null, counter_currency: null, occurred_on: "2020-01-02", note: null,
        units_delta: null, counter_units_delta: null, flow_kind: null,
      });
    });
  });

  it("stores a cross-currency transfer with its counter leg and both units", () => {
    rolledBack(() => {
      const id = insertMovement({
        fromAccountId: a!, toAccountId: b!, amount: 950000, currency: "clp", counterAmount: 1000, counterCurrency: "usd",
        note: "vitest transfer", unitsDelta: "1.25", counterUnitsDelta: 2, flowKind: "fx_exchange", ...day,
      });
      expect(stored(id)).toEqual({
        account_id: null, from_account_id: a, to_account_id: b, amount: 950000, currency: "clp",
        counter_amount: 1000, counter_currency: "usd", occurred_on: "2020-01-02", note: "vitest transfer",
        units_delta: 1.25, counter_units_delta: 2, flow_kind: "fx_exchange",
      });
    });
  });

  it("stamps the movement's flow as first seen now, in write order", () => {
    rolledBack(() => {
      const stamp = (id: number) =>
        db
          .prepare(
            `SELECT f.first_seen_at AS at, f.first_seen_seq AS seq FROM movements m
             JOIN flow_first_seen f ON f.flow_id = m.flow_id WHERE m.id = ?`
          )
          .get(id) as { at: string; seq: number } | undefined;
      const first = stamp(insertMovement({ accountId: a!, amount: -10, currency: "clp", ...day }));
      const second = stamp(insertMovement({ accountId: a!, amount: -20, currency: "clp", ...day }));
      expect(first?.at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
      expect(second!.seq).toBeGreaterThan(first!.seq);
    });
  });

  it("refuses the shapes the table's CHECKs refuse, before writing", () => {
    const count = () => (db.prepare(`SELECT COUNT(*) AS n FROM movements`).get() as { n: number }).n;
    const before = count();
    const transfer = { fromAccountId: a!, toAccountId: b!, amount: 10, currency: "clp", ...day };
    expect(() => insertMovement({ ...transfer, toAccountId: a! })).toThrow(/to itself/);
    expect(() => insertMovement({ ...transfer, counterAmount: 5 })).toThrow(/both or neither/);
    expect(() => insertMovement({ ...transfer, counterCurrency: "usd" })).toThrow(/both or neither/);
    expect(() => insertMovement({ ...transfer, counterAmount: 5, counterCurrency: "clp" })).toThrow(/own currency/);
    expect(() => insertMovement({ ...transfer, accountId: a! } as never)).toThrow(/two accounts/);
    expect(() => insertMovement({ accountId: a!, amount: 10, currency: "clp", counterAmount: 5, counterCurrency: "usd", ...day } as never)).toThrow(
      /only a transfer/
    );
    expect(() => insertMovement({ accountId: a!, amount: Number.NaN, currency: "clp", ...day })).toThrow(/not a number/);
    expect(count()).toBe(before);
  });
});
