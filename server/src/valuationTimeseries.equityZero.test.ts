import { describe, expect, it } from "vitest";
import { db } from "./db.js";
import {
  equityShareUnitsThroughYmd,
  firstEquityShareActivityYmd,
} from "./brokerageEquityMtm.js";
import { getGroupValuationTimeseries } from "./valuationTimeseries.js";

describe("getGroupValuationTimeseries equity zero position", () => {
  it("OILK chart drops to 0 after stock_sell (no forward-fill of prior MTM)", () => {
    const oilk = db
      .prepare(`SELECT id FROM accounts WHERE equity_ticker = 'OILK' LIMIT 1`)
      .get() as { id: number } | undefined;
    if (!oilk) return;

    const sell = db
      .prepare(
        `SELECT occurred_on FROM movements
         WHERE from_account_id = ? AND flow_kind = 'stock_sell'
         ORDER BY occurred_on DESC LIMIT 1`
      )
      .get(oilk.id) as { occurred_on: string } | undefined;
    if (!sell) return;

    const first = firstEquityShareActivityYmd(oilk.id);
    expect(first).toBeTruthy();

    expect(equityShareUnitsThroughYmd(oilk.id, sell.occurred_on)).toBeLessThanOrEqual(0);

    const ts = getGroupValuationTimeseries("brokerage", "clp", "acciones");
    const line = ts?.accounts_in_group?.accounts.find((a) => a.account_id === oilk.id);
    expect(line).toBeDefined();
    const dk = String(oilk.id);

    const beforeFirst = ts!.accounts_in_group!.points.filter(
      (p) => String(p.as_of_date) < first!
    );
    for (const row of beforeFirst) {
      expect(row[dk]).toBeNull();
    }

    // Server tail clip: the sell month keeps one plotted 0, later months are null (line ends).
    const afterSell = ts!.accounts_in_group!.points.filter(
      (p) => String(p.as_of_date) >= sell.occurred_on.slice(0, 10)
    );
    expect(afterSell.length).toBeGreaterThan(0);
    expect(afterSell[0]![dk]).toBe(0);
    for (const row of afterSell) {
      expect(row[dk] === 0 || row[dk] === null).toBe(true);
    }
    if (afterSell.length > 2) {
      expect(afterSell[afterSell.length - 1]![dk]).toBeNull();
      expect(ts!.accounts_in_group!.tail_clipped_keys).toContain(dk);
    }
  });
});