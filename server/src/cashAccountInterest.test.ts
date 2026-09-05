import { afterEach, describe, expect, it } from "vitest";
import { db } from "./db.js";
import {
  clpCashInterestClpThroughDate,
  usdCashInterestUsdThroughDate,
} from "./cashAccountInterest.js";

describe("cash interest net of fees", () => {
  let accountId = 0;

  afterEach(() => {
    if (accountId) {
      db.prepare(`DELETE FROM movements WHERE account_id = ?`).run(accountId);
      db.prepare(`DELETE FROM accounts WHERE id = ?`).run(accountId);
      accountId = 0;
    }
  });

  function createAccount(): number {
    const group = db.prepare(`SELECT id FROM asset_groups ORDER BY id LIMIT 1`).get() as {
      id: number;
    };
    accountId = Number(
      db
        .prepare(
          `INSERT INTO accounts (asset_group_id, name, notes, import_key)
           VALUES (?, 'vitest cash interest', 'vitest', 'vitest-cash-interest')`
        )
        .run(group.id).lastInsertRowid
    );
    return accountId;
  }

  it("CLP: interest minus commissions, fee sign-agnostic", () => {
    const id = createAccount();
    const ins = db.prepare(
      `INSERT INTO movements (account_id, amount, currency, occurred_on, note, flow_kind)
       VALUES (?, ?, 'clp', ?, 'vitest', ?)`
    );
    ins.run(id, 100, "2099-01-05", "savings_earnings");
    ins.run(id, -30, "2099-01-18", "cash_fee"); // CLP fee rows are stored negative
    expect(clpCashInterestClpThroughDate(id, "2099-12-31")).toBe(70);
    // Window respects occurred_on: before the fee, interest alone.
    expect(clpCashInterestClpThroughDate(id, "2099-01-10")).toBe(100);
  });

  it("USD: interest minus commissions with the positive single-leg convention", () => {
    const id = createAccount();
    const ins = db.prepare(
      `INSERT INTO movements (account_id, amount, currency, occurred_on, note, flow_kind)
       VALUES (?, ?, 'usd', ?, 'vitest', ?)`
    );
    ins.run(id, 10, "2099-02-01", "savings_earnings");
    ins.run(id, 4, "2099-02-18", "cash_fee"); // USD single-leg rows stored positive, kind carries direction
    expect(usdCashInterestUsdThroughDate(id, "2099-12-31")).toBe(6);
  });
});
