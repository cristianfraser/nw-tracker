import { describe, expect, it } from "vitest";
import { db } from "./db.js";
import { seedNavTree } from "./seedNavTree.js";

describe("seedNavTree cash_eqs hub", () => {
  it("creates nav_hub with cash_savings and checking_accounts children", () => {
    seedNavTree();
    const cash = db
      .prepare(
        `SELECT id, group_kind, asset_group_slug, route_path, active_prefix
         FROM portfolio_groups WHERE slug = 'cash_eqs'`
      )
      .get() as {
      id: number;
      group_kind: string;
      asset_group_slug: string | null;
      route_path: string | null;
      active_prefix: string | null;
    };
    expect(cash).toBeTruthy();
    expect(cash.group_kind).toBe("nav_hub");
    expect(cash.asset_group_slug).toBeNull();
    expect(cash.route_path).toBe("/cash_eqs");
    expect(cash.active_prefix).toBe("/cash_eqs");

    const children = db
      .prepare(
        `SELECT slug, route_path, asset_group_slug, dashboard_bucket_slug
         FROM portfolio_groups
         WHERE parent_id = ?
         ORDER BY sort_order`
      )
      .all(cash.id) as {
      slug: string;
      route_path: string | null;
      asset_group_slug: string | null;
      dashboard_bucket_slug: string | null;
    }[];
    const slugs = children.map((c) => c.slug);
    expect(slugs).toContain("cash_savings");
    expect(slugs).toContain("checking_accounts");

    const savings = children.find((c) => c.slug === "cash_savings");
    expect(savings?.route_path).toBe("/cash_eqs");
    expect(savings?.asset_group_slug).toBe("cash_eqs__cash_savings");
    expect(savings?.dashboard_bucket_slug).toBe("cash_eqs");

    const checking = children.find((c) => c.slug === "checking_accounts");
    expect(checking?.route_path).toBe("/cash_eqs/checking");
    expect(checking?.asset_group_slug).toBe("cash_eqs__checking_accounts");

    const savingsAccounts = db
      .prepare(
        `SELECT COUNT(*) AS n FROM portfolio_group_items
         WHERE group_id = (SELECT id FROM portfolio_groups WHERE slug = 'cash_savings')
           AND item_kind = 'account'`
      )
      .get() as { n: number };
    expect(savingsAccounts.n).toBeGreaterThan(0);

    const cashRootAccounts = db
      .prepare(
        `SELECT COUNT(*) AS n FROM portfolio_group_items
         WHERE group_id = ? AND item_kind = 'account'`
      )
      .get(cash.id) as { n: number };
    expect(cashRootAccounts.n).toBe(0);

    const nwChild = db
      .prepare(
        `SELECT c.slug FROM portfolio_groups p
         JOIN portfolio_group_items i ON i.group_id = p.id AND i.item_kind = 'group'
         JOIN portfolio_groups c ON c.id = i.child_group_id
         WHERE p.slug = 'net_worth' AND c.slug = 'cash_savings'`
      )
      .get() as { slug: string } | undefined;
    expect(nwChild?.slug).toBe("cash_savings");
  });
});
