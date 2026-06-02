import { describe, expect, it } from "vitest";
import { db } from "./db.js";
import { createPanelStockAccount } from "./createPanelStockAccount.js";
import { equityTickerForAccount } from "./brokerageEquityMtm.js";
import { parsePanelAccountNotes } from "./panelAccountNotes.js";

describe("createPanelStockAccount", () => {
  it("creates category, account, and brokerage movements", () => {
    const slug = `panel_test_${Date.now()}`;
    const ticker = "QQQ";
    const result = createPanelStockAccount({
      account: {
        name: "QQQ test",
        category_slug: slug,
        bucket_slug: "brokerage_acciones",
        ticker,
        price_source: "stocks_nyse",
        exclude_from_group_totals: false,
      },
      initial_movements: [
        {
          occurred_on: "2026-03-01",
          flow_kind: "deposit_clp",
          amount_clp: 3_000_000,
          amount_usd: null,
          units_delta: null,
        },
        {
          occurred_on: "2026-03-02",
          flow_kind: "compra_usd",
          amount_clp: null,
          amount_usd: 3353.07,
          units_delta: null,
        },
        {
          occurred_on: "2026-03-03",
          flow_kind: "compra_usd",
          amount_clp: null,
          amount_usd: null,
          units_delta: 59.760886574,
        },
      ],
    });

    expect(result.account_id).toBeGreaterThan(0);
    expect(result.movement_ids).toHaveLength(3);
    expect(equityTickerForAccount(result.account_id)).toBe("QQQ");

    const navLink = db
      .prepare(
        `SELECT 1 AS o FROM portfolio_group_items pgi
         JOIN portfolio_groups pg ON pg.id = pgi.group_id
         WHERE pg.slug = 'brokerage_acciones' AND pgi.account_id = ?`
      )
      .get(result.account_id) as { o: number } | undefined;
    expect(navLink).toBeDefined();

    const acc = db
      .prepare(`SELECT notes, equity_ticker FROM accounts WHERE id = ?`)
      .get(result.account_id) as { notes: string; equity_ticker: string };
    expect(acc.equity_ticker).toBe("QQQ");
    expect(parsePanelAccountNotes(acc.notes)?.ticker).toBe("QQQ");

    const bucket = db
      .prepare(
        `SELECT g.slug FROM accounts a JOIN asset_groups g ON g.id = a.asset_group_id WHERE a.id = ?`
      )
      .get(result.account_id) as { slug: string };
    expect(bucket.slug).toBe(`brokerage_acciones__${slug}`);

    db.prepare(`DELETE FROM movements WHERE account_id = ?`).run(result.account_id);
    db.prepare(`DELETE FROM accounts WHERE id = ?`).run(result.account_id);
    if (result.created_leaf_bucket) {
      db.prepare(`DELETE FROM asset_groups WHERE id = ?`).run(result.asset_group_id);
    }
  });
});
