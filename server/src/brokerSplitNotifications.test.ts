import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { rolledBack } from "./ingestReceiver.js";
import type { BrokerNotification } from "nw-tracker-contracts";
import { applyBrokerNotifications } from "./brokerNotificationsApply.js";
import { wholeSplitRatio } from "./brokerSplitNotifications.js";
import { db } from "./db.js";
import { listEquitySplits } from "./equitySplits.js";

const TICKER = "VTSPLITM";

function notice(units: string, unitsAfter: string, at = "2025-04-08T05:35:00.000Z"): BrokerNotification {
  return {
    message_id: `<vitest-split-${units}-${unitsAfter}-${at}@test>`,
    occurred_at: at,
    subject: `${TICKER} tuvo una división de acciones, y varió tu cantidad de Stocks`,
    kind: "stock_split",
    ticker: TICKER,
    fund_name: null,
    goal_name: null,
    amount: null,
    gross_amount: null,
    currency: null,
    units,
    price: null,
    clp_amount: null,
    paid_to: null,
    units_after: unitsAfter,
  };
}

describe("wholeSplitRatio", () => {
  it("reads N:1 and 1:N, and nothing else", () => {
    expect(wholeSplitRatio(12.34567891, 37.03703673)).toEqual({ numerator: 3, denominator: 1 });
    expect(wholeSplitRatio(10, 2)).toEqual({ numerator: 1, denominator: 5 });
    expect(wholeSplitRatio(10, 15)).toBeNull();
  });
});

describe("Racional split notices", () => {
  let usd: { id: number; cleanup: () => void };
  let stock: number;

  beforeEach(() => {
    const group = db.prepare(`SELECT id FROM asset_groups WHERE slug LIKE 'brokerage_acciones__%' LIMIT 1`).get() as { id: number };
    const existing = db.prepare(`SELECT id FROM accounts WHERE import_key = 'import:panel|kind=usd|key=usd'`).get() as
      | { id: number }
      | undefined;
    if (existing) usd = { id: existing.id, cleanup: () => {} };
    else {
      const id = Number(
        db
          .prepare(
            `INSERT INTO accounts (asset_group_id, name, import_key) VALUES (?, 'vitest Racional USD', 'import:panel|kind=usd|key=usd')`
          )
          .run(group.id).lastInsertRowid
      );
      usd = { id, cleanup: () => db.prepare(`DELETE FROM accounts WHERE id = ?`).run(id) };
    }
    stock = Number(
      db
        .prepare(`INSERT INTO accounts (asset_group_id, name, equity_ticker) VALUES (?, 'vitest split notice', ?)`)
        .run(group.id, TICKER).lastInsertRowid
    );
    db.prepare(
      `INSERT INTO movements (from_account_id, to_account_id, amount, currency, occurred_on, flow_kind, units_delta)
       VALUES (?, ?, 600, 'usd', '2025-04-01', 'stock_buy', 2)`
    ).run(usd.id, stock);
    db.prepare(`INSERT INTO equity_daily (ticker, trade_date, close, currency) VALUES (?, '2025-04-07', 300, 'usd')`).run(TICKER);
  });

  afterEach(() => {
    db.prepare(`DELETE FROM movements WHERE account_id = ? OR from_account_id = ? OR to_account_id = ?`).run(stock, stock, stock);
    db.prepare(`DELETE FROM accounts WHERE id = ?`).run(stock);
    db.prepare(`DELETE FROM equity_daily WHERE ticker = ?`).run(TICKER);
    db.prepare(`DELETE FROM equity_splits WHERE ticker = ?`).run(TICKER);
    usd.cleanup();
  });

  const apply = (n: BrokerNotification, write = true) => {
    const send = () => applyBrokerNotifications({ broker: "racional", notifications: [n] }).planned;
    return write ? send() : rolledBack(send);
  };

  it("records the split the notice states, on the day it was mailed, and is a duplicate after", () => {
    expect(apply(notice("2", "6"), false)).toMatchObject([{ kind: "stock_split", state: "split_recorded" }]);
    expect(listEquitySplits(TICKER)).toEqual([]);
    expect(apply(notice("2", "6"))).toMatchObject([{ state: "split_recorded" }]);
    expect(listEquitySplits(TICKER)).toMatchObject([{ ex_date: "2025-04-08", numerator: 3, denominator: 1, source: "broker" }]);
    expect(
      db.prepare(`SELECT units_delta FROM movements WHERE account_id = ? AND flow_kind = 'stock_split'`).get(stock)
    ).toEqual({ units_delta: 4 });
    expect(db.prepare(`SELECT close FROM equity_daily WHERE ticker = ?`).get(TICKER)).toEqual({ close: 100 });
    // The same split from another source a day later is the one already recorded.
    expect(apply(notice("2", "6", "2025-04-09T12:00:00.000Z"))).toMatchObject([{ state: "duplicate" }]);
  });

  it("records nothing when the notice's count is not what the ledger holds at the broker", () => {
    expect(apply(notice("2.5", "7.5"))).toMatchObject([{ state: "conflict" }]);
    expect(listEquitySplits(TICKER)).toEqual([]);
  });
});
