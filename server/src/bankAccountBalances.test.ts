import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "./db.js";
import { createPanelAccount } from "./createPanelAccount.js";
import { seedNavTree } from "./seedNavTree.js";
import {
  applyBankAccountBalances,
  bankBalanceMessageKind,
  judgeLatestBankAccountBalances,
} from "./bankAccountBalances.js";

const NUMBER = "005199990077";
const REF_A = "vitest-balances-a.json";
const REF_B = "vitest-balances-b.json";
let accountId = 0;

function payload(balance: number, observedAt: string) {
  return {
    issuer: "santander",
    observed_at: observedAt,
    accounts: [
      { number: NUMBER, product: "checking" as const, currency: "usd" as const, balance, label: "CTA CORRIENTE MX", status: "ACTIVA" },
      { number: "007099990078", product: "demand_deposit" as const, currency: "clp" as const, balance: 0, label: "VISTA", status: "ACTIVA" },
    ],
  };
}

function cleanup(): void {
  db.prepare(`DELETE FROM bank_account_balance_snapshots WHERE source_ref IN (?, ?)`).run(REF_A, REF_B);
  if (accountId) {
    db.prepare(`DELETE FROM movements WHERE account_id = ?`).run(accountId);
    db.prepare(`DELETE FROM portfolio_group_items WHERE account_id = ?`).run(accountId);
    db.prepare(`DELETE FROM account_sync_sources WHERE account_id = ?`).run(accountId);
    db.prepare(`DELETE FROM accounts WHERE id = ?`).run(accountId);
    db.prepare(`DELETE FROM asset_groups WHERE slug LIKE '%vitest_bank_usd__usd'`).run();
    seedNavTree();
  }
}

describe("bank account balances", () => {
  beforeAll(() => {
    const created = createPanelAccount({
      account: {
        account_type: "usd_cash",
        name: "Vitest Bank USD",
        bucket_slug: "cash_savings",
        category_slug: "vitest_bank_usd",
        exclude_from_group_totals: false,
      },
    });
    accountId = created.account_id;
    db.prepare(`INSERT INTO bank_account_numbers (account_id, issuer, number, currency) VALUES (?, 'santander', ?, 'usd')`).run(
      accountId,
      NUMBER
    );
    // One interest credit of US$100 on 2020-01-02 (a single-leg USD row stays positive).
    db.prepare(
      `INSERT INTO movements (account_id, amount, currency, occurred_on, note, flow_kind)
       VALUES (?, 100, 'usd', '2020-01-02', 'vitest-balances', 'savings_earnings')`
    ).run(accountId);
  });

  afterAll(cleanup);

  it("records each observation once and maps the declared number", () => {
    const first = applyBankAccountBalances(payload(100, "2020-01-05T02:00:00.000Z"), REF_A);
    expect(first.duplicate).toBe(false);
    expect(first.details.recorded).toBe(2);
    expect(first.details.known).toEqual([{ account_id: accountId, number: NUMBER, currency: "usd", balance: 100 }]);
    expect(first.details.unknown.map((u) => u.number)).toEqual(["007099990078"]);
    expect(applyBankAccountBalances(payload(100, "2020-01-05T02:00:00.000Z"), REF_A).duplicate).toBe(true);
  });

  it("agrees with the ledger to the cent, and flags the first mismatch once", () => {
    const ok = judgeLatestBankAccountBalances().filter((v) => v.account_id === accountId);
    expect(ok).toMatchObject([{ status: "ok", bank_balance: 100, ledger_balance: 100, diff: 0, fresh: true }]);
    expect(judgeLatestBankAccountBalances().find((v) => v.account_id === accountId)?.fresh).toBe(false);

    applyBankAccountBalances(payload(110, "2020-01-06T02:00:00.000Z"), REF_B);
    const off = judgeLatestBankAccountBalances().filter((v) => v.account_id === accountId);
    expect(off).toMatchObject([{ status: "mismatch", bank_balance: 110, ledger_balance: 100, diff: -10, fresh: true }]);
    expect(bankBalanceMessageKind(off)).toBe("notification");
  });
});
