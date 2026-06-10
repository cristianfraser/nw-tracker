import { describe, expect, it } from "vitest";
import { buildAccountDetailBundle } from "./accountDetailBundle.js";
import { BROKERAGE_FLOW_KINDS } from "./brokerageFlowMovement.js";
import { createPanelStockAccount } from "./createPanelStockAccount.js";
import { db } from "./db.js";

describe("accountDetailBundle movement_create", () => {
  it("exposes brokerage_flow_kinds for equity_ticker accounts (OILK)", async () => {
    const row = db
      .prepare(`SELECT id FROM accounts WHERE equity_ticker = 'OILK' LIMIT 1`)
      .get() as { id: number } | undefined;
    if (!row) return;

    const bundle = await buildAccountDetailBundle(row.id, "clp", "monthly", {});
    expect(bundle).not.toBeNull();
    expect(bundle!.summary.movement_create?.brokerage_flow_kinds).toEqual(BROKERAGE_FLOW_KINDS);
  });

  it("exposes brokerage_flow_kinds for panel-created stocks (leaf slug ≠ bucket)", () => {
    const slug = `panel_mv_create_${Date.now()}`;
    const result = createPanelStockAccount({
      account: {
        name: "Panel movement form test",
        category_slug: slug,
        bucket_slug: "brokerage_acciones",
        ticker: "QQQ",
        price_source: "stocks_nyse",
        exclude_from_group_totals: false,
      },
      initial_movements: [],
    });

    return buildAccountDetailBundle(result.account_id, "clp", "monthly", {}).then((bundle) => {
      expect(bundle).not.toBeNull();
      expect(bundle!.summary.movement_create?.brokerage_flow_kinds).toEqual(BROKERAGE_FLOW_KINDS);

      db.prepare(`DELETE FROM movements WHERE account_id = ?`).run(result.account_id);
      db.prepare(`DELETE FROM accounts WHERE id = ?`).run(result.account_id);
      if (result.created_leaf_bucket) {
        db.prepare(`DELETE FROM asset_groups WHERE id = ?`).run(result.asset_group_id);
      }
    });
  });
});
