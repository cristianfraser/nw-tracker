import { describe, expect, it } from "vitest";
import { db } from "./db.js";
import { createPanelAccount } from "./createPanelAccount.js";
import { equityTickerForAccount } from "./brokerageEquityMtm.js";
import { movementCreateSchemaForAccount } from "./movementUnitsPolicy.js";
import { parsePanelAccountNotes } from "./panelAccountNotes.js";

function accountRow(accountId: number) {
  return db
    .prepare(
      `SELECT g.slug AS bucket_slug, g.slug AS group_slug, a.notes AS notes, a.equity_ticker AS equity_ticker
       FROM accounts a JOIN asset_groups g ON g.id = a.asset_group_id WHERE a.id = ?`
    )
    .get(accountId) as {
    bucket_slug: string;
    group_slug: string;
    notes: string | null;
    equity_ticker: string | null;
  };
}

function cleanup(result: { account_id: number; asset_group_id: number; created_leaf_bucket: boolean }) {
  db.prepare(`DELETE FROM movements WHERE account_id = ?`).run(result.account_id);
  db.prepare(`DELETE FROM accounts WHERE id = ?`).run(result.account_id);
  if (result.created_leaf_bucket) {
    db.prepare(`DELETE FROM asset_groups WHERE id = ?`).run(result.asset_group_id);
  }
}

describe("createPanelAccount", () => {
  it("creates an equity account (empty) and links it under the chosen bucket", () => {
    const slug = `panel_eq_${Date.now()}`;
    const result = createPanelAccount({
      account: {
        account_type: "equity",
        name: "QQQ test",
        category_slug: slug,
        bucket_slug: "brokerage_acciones",
        ticker: "QQQ",
        exclude_from_group_totals: false,
      },
    });

    expect(result.account_id).toBeGreaterThan(0);
    expect(result.ticker).toBe("QQQ");
    expect(equityTickerForAccount(result.account_id)).toBe("QQQ");
    expect(db.prepare(`SELECT COUNT(*) AS n FROM movements WHERE account_id = ?`).get(result.account_id))
      .toEqual({ n: 0 });

    const acc = accountRow(result.account_id);
    expect(parsePanelAccountNotes(acc.notes)?.ticker).toBe("QQQ");
    expect(acc.bucket_slug).toBe(`brokerage_acciones__${slug}`);
    expect(movementCreateSchemaForAccount(acc)?.brokerage_flow_kinds).toBeDefined();

    const navLink = db
      .prepare(
        `SELECT 1 AS o FROM portfolio_group_items pgi
         JOIN portfolio_groups pg ON pg.id = pgi.group_id
         WHERE pg.slug = 'brokerage_acciones' AND pgi.account_id = ?`
      )
      .get(result.account_id) as { o: number } | undefined;
    expect(navLink).toBeDefined();

    cleanup(result);
  });

  it("creates a CLP cash account under a non-default bucket (type carried by leaf-kind, not bucket)", () => {
    const name = `Efectivo CLP ${Date.now()}`;
    const result = createPanelAccount({
      account: {
        account_type: "clp_cash",
        name,
        bucket_slug: "cash_savings",
        exclude_from_group_totals: false,
      },
    });

    expect(result.account_id).toBeGreaterThan(0);
    expect(result.ticker).toBeNull();
    const acc = accountRow(result.account_id);
    // Leaf slug ends in `__clp` so the CLP cash ledger behavior resolves regardless of bucket.
    expect(acc.bucket_slug.endsWith("__clp")).toBe(true);
    expect(acc.notes).toMatch(/^import:panel\|kind=clp\|key=/);

    cleanup(result);
  });

  it("creates a USD cash account and exposes USD cash flow kinds", () => {
    const name = `Efectivo USD ${Date.now()}`;
    const result = createPanelAccount({
      account: {
        account_type: "usd_cash",
        name,
        bucket_slug: "cash_savings",
        exclude_from_group_totals: false,
      },
    });

    const acc = accountRow(result.account_id);
    expect(acc.bucket_slug.endsWith("__usd")).toBe(true);
    const schema = movementCreateSchemaForAccount(acc);
    expect(schema?.brokerage_flow_kinds).toContain("deposit_clp");
    expect(schema?.brokerage_flow_kinds).toContain("compra_usd_venta_clp");

    cleanup(result);
  });

  it("rejects a liability bucket and an unsupported type", () => {
    expect(() =>
      createPanelAccount({
        account: {
          account_type: "clp_cash",
          name: "bad",
          bucket_slug: "does_not_exist_bucket",
          exclude_from_group_totals: false,
        },
      })
    ).toThrow(/unknown bucket/);

    expect(() =>
      createPanelAccount({
        // @ts-expect-error intentionally invalid type
        account: { account_type: "afp", name: "x", bucket_slug: "cash_savings", exclude_from_group_totals: false },
      })
    ).toThrow(/unsupported account_type/);
  });
});
