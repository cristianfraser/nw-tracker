import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import express from "express";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { accountCashCurrency } from "./cashCurrency.js";
import { createPanelAccount } from "./createPanelAccount.js";
import { db } from "./db.js";
import { registerAccountsRoutes } from "./routes/accounts.js";

/**
 * `GET /api/accounts` (the full list) states each cash ledger's currency as `cash_currency`
 * (wave 9 `ut-currency-seams`): what the stock trade form offers as settlement accounts and
 * labels the amount with. Any other account reads null.
 */
describe("GET /api/accounts states each cash ledger's currency", () => {
  const created: { account_id: number; asset_group_id: number; created_leaf_bucket: boolean }[] = [];
  let server: Server;
  let base = "";
  let euroId = 0;
  let pesoId = 0;

  beforeAll(async () => {
    const add = (input: Parameters<typeof createPanelAccount>[0]) => {
      const out = createPanelAccount(input);
      created.push(out);
      return out.account_id;
    };
    euroId = add({
      account: {
        account_type: "foreign_cash",
        currency: "eur",
        name: "Vitest list euro cash",
        bucket_slug: "cash_savings",
        category_slug: "vitest_list_cash_currency_eur",
        exclude_from_group_totals: true,
      },
    });
    pesoId = add({
      account: {
        account_type: "clp_cash",
        name: "Vitest list peso cash",
        bucket_slug: "cash_savings",
        category_slug: "vitest_list_cash_currency_clp",
        exclude_from_group_totals: true,
      },
    });
    const app = express();
    app.use(express.json());
    registerAccountsRoutes(app);
    server = await new Promise<Server>((resolve) => {
      const s: Server = app.listen(0, "127.0.0.1", () => resolve(s));
    });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    for (const c of created) {
      db.prepare(`DELETE FROM accounts WHERE id = ?`).run(c.account_id);
      if (c.created_leaf_bucket) db.prepare(`DELETE FROM asset_groups WHERE id = ?`).run(c.asset_group_id);
    }
  });

  it("a euro ledger reads eur, a peso ledger clp, and every row agrees with accountCashCurrency", async () => {
    const res = await fetch(`${base}/api/accounts`);
    expect(res.status).toBe(200);
    const { accounts } = (await res.json()) as { accounts: { id: number; cash_currency: string | null }[] };
    const byId = new Map(accounts.map((a) => [a.id, a]));
    expect(byId.get(euroId)!.cash_currency).toBe("eur");
    expect(byId.get(pesoId)!.cash_currency).toBe("clp");
    for (const a of accounts) {
      expect(a).toHaveProperty("cash_currency");
      expect(a.cash_currency).toBe(accountCashCurrency(a.id));
    }
    // The list holds accounts that are not cash ledgers, and they read null.
    expect(accounts.some((a) => a.cash_currency == null)).toBe(true);
  });

  it("states the currency of every money ledger as ledger_currency, checking ledgers included", async () => {
    const res = await fetch(`${base}/api/accounts`);
    const { accounts } = (await res.json()) as {
      accounts: { id: number; bucket_slug: string; cash_currency: string | null; ledger_currency: string | null }[];
    };
    const byId = new Map(accounts.map((a) => [a.id, a]));
    expect(byId.get(euroId)!.ledger_currency).toBe("eur");
    expect(byId.get(pesoId)!.ledger_currency).toBe("clp");
    // A cash ledger's two fields agree.
    for (const a of accounts) {
      expect(a).toHaveProperty("ledger_currency");
      if (a.cash_currency != null) expect(a.ledger_currency).toBe(a.cash_currency);
    }
    // The synthetic person's cartola checking account holds pesos and is not a cash ledger.
    const checking = accounts.filter((a) => a.bucket_slug === "cash_eqs__cuenta_corriente");
    expect(checking.length).toBeGreaterThan(0);
    for (const a of checking) {
      expect(a.cash_currency).toBeNull();
      expect(a.ledger_currency).toBe("clp");
    }
    // A stock account is not a money ledger.
    const stocks = accounts.filter((a) => a.bucket_slug.startsWith("brokerage_acciones"));
    expect(stocks.length).toBeGreaterThan(0);
    for (const a of stocks) expect(a.ledger_currency).toBeNull();
  });
});
