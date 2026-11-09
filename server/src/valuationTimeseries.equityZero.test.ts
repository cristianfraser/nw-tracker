import { describe, expect, it } from "vitest";
import { db } from "./db.js";
import { firstEquityShareActivityYmd } from "./brokerageEquityMtm.js";
import { holdingFixtures } from "./test/holdingParityFixtures.js";

describe("firstEquityShareActivityYmd", () => {
  const fixtures = holdingFixtures();

  it("follows a backdated buy and its deletion (no process-lifetime memo)", () => {
    const id = fixtures.account("first buy", "brokerage_acciones__%", "VFIRST");
    fixtures.singleLeg(id, "2024-03-01", 1000, 10, "stock_buy", "usd");
    expect(firstEquityShareActivityYmd(id)).toBe("2024-03-01");

    const backdated = Number(
      db
        .prepare(
          `INSERT INTO movements (account_id, amount, currency, occurred_on, flow_kind, units_delta)
           VALUES (?, 500, 'usd', '2023-06-01', 'stock_buy', 5)`
        )
        .run(id).lastInsertRowid
    );
    expect(firstEquityShareActivityYmd(id)).toBe("2023-06-01");
    db.prepare(`DELETE FROM movements WHERE id = ?`).run(backdated);
    expect(firstEquityShareActivityYmd(id)).toBe("2024-03-01");
  });
});
