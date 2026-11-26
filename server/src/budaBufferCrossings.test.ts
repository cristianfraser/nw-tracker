import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "./db.js";
import { budaBufferCrossings } from "./budaBufferCrossings.js";

const NOTE = "vitest-buda-crossings";
let buffer = 0;
let coin = 0;
const ids: Record<string, number> = {};

function account(name: string): number {
  const group = db.prepare(`SELECT id FROM asset_groups ORDER BY id LIMIT 1`).get() as { id: number };
  return Number(db.prepare(`INSERT INTO accounts (asset_group_id, name) VALUES (?, ?)`).run(group.id, name).lastInsertRowid);
}

function movement(accountId: number, day: string, amount: number, opts: { units?: number; flowKind?: string } = {}): number {
  return Number(
    db
      .prepare(
        `INSERT INTO movements (account_id, amount, currency, occurred_on, note, units_delta, flow_kind) VALUES (?, ?, 'clp', ?, ?, ?, ?)`
      )
      .run(accountId, amount, day, NOTE, opts.units ?? null, opts.flowKind ?? null).lastInsertRowid
  );
}

beforeAll(() => {
  buffer = account("vitest buda buffer");
  coin = account("vitest buda coin");
  ids.deposit = movement(buffer, "2025-01-02", 300_000);
  ids.buyCash = movement(buffer, "2025-01-03", -200_000);
  ids.twinBuyCash = movement(buffer, "2025-01-03", -200_000);
  ids.buy = movement(coin, "2025-01-03", 200_000, { units: 0.01 });
  ids.sellCash = movement(buffer, "2025-02-03", 50_000);
  ids.sell = movement(coin, "2025-02-03", -50_000, { units: -0.002 });
  ids.fee = movement(buffer, "2025-02-04", -1_000, { flowKind: "cash_fee" });
  ids.withdrawal = movement(buffer, "2025-03-01", -100_000);
  const kind = db.prepare(`INSERT INTO crypto_movement_kinds (movement_id, kind) VALUES (?, ?)`);
  kind.run(ids.buy, "buy");
  kind.run(ids.sell, "sell");
});

afterAll(() => {
  db.prepare(`DELETE FROM movements WHERE note = ?`).run(NOTE);
  db.prepare(`DELETE FROM accounts WHERE id IN (?, ?)`).run(buffer, coin);
});

describe("budaBufferCrossings", () => {
  it("a buffer row paying for or receiving a coin trade is a trade; the rest with no flow kind cross the boundary", () => {
    const c = budaBufferCrossings(buffer, new Set([coin]));
    // One coin buy takes one of the two same-day −200.000 rows; the other one left the bucket.
    expect([...c.deposits].sort()).toEqual([ids.deposit]);
    expect([...c.withdrawals].sort((a, b) => a - b)).toEqual([ids.twinBuyCash, ids.withdrawal]);
  });

  it("a coin trade with no buffer row on its day throws", () => {
    const lonely = movement(coin, "2025-04-01", 70_000, { units: 0.003 });
    db.prepare(`INSERT INTO crypto_movement_kinds (movement_id, kind) VALUES (?, 'buy')`).run(lonely);
    try {
      expect(() => budaBufferCrossings(buffer, new Set([coin]))).toThrow(new RegExp(`coin buy movement ${lonely}`));
    } finally {
      db.prepare(`DELETE FROM movements WHERE id = ?`).run(lonely);
    }
  });
});
