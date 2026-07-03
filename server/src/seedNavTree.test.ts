import { describe, expect, it } from "vitest";
import { db } from "./db.js";
import { seedNavTree } from "./seedNavTree.js";

describe("seedNavTree cash_eqs hub", () => {
  it("creates nav_bucket with cash_savings and checking_accounts children", () => {
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
    expect(cash.group_kind).toBe("nav_bucket");
    expect(cash.asset_group_slug).toBeNull();
    expect(cash.route_path).toBe("/cash_eqs");
    expect(cash.active_prefix).toBe("/cash_eqs");

    const children = db
      .prepare(
        `SELECT slug, route_path, active_prefix, asset_group_slug, dashboard_bucket_slug, group_kind
         FROM portfolio_groups
         WHERE parent_id = ?
         ORDER BY sort_order`
      )
      .all(cash.id) as {
      slug: string;
      route_path: string | null;
      active_prefix: string | null;
      asset_group_slug: string | null;
      dashboard_bucket_slug: string | null;
      group_kind: string;
    }[];
    const slugs = children.map((c) => c.slug);
    expect(slugs).toContain("cash_savings");
    expect(slugs).toContain("checking_accounts");

    const savings = children.find((c) => c.slug === "cash_savings");
    expect(savings?.route_path).toBe("/cash_eqs/savings");
    expect(savings?.active_prefix).toBe("/cash_eqs/savings");
    expect(savings?.asset_group_slug).toBe("cash_eqs__cash_savings");
    expect(savings?.dashboard_bucket_slug).toBeNull();

    const checking = children.find((c) => c.slug === "checking_accounts");
    expect(checking?.route_path).toBe("/cash_eqs/checking");
    expect(checking?.asset_group_slug).toBe("cash_eqs__checking_accounts");
    expect(checking?.group_kind).toBe("bucket");

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
         WHERE p.slug = 'net_worth' AND c.slug = 'cash_eqs'`
      )
      .get() as { slug: string } | undefined;
    expect(nwChild?.slug).toBe("cash_eqs");
  });
});

describe("seedNavTree operational credit cards entry", () => {
  it("seeds a top-level main-section link to /credit-cards (idempotent)", () => {
    seedNavTree();
    seedNavTree();
    const rows = db
      .prepare(
        `SELECT id, parent_id, route_path, active_prefix, sidebar_section, group_kind, nav_end
         FROM portfolio_groups WHERE slug = 'credit_cards'`
      )
      .all() as {
      id: number;
      parent_id: number | null;
      route_path: string | null;
      active_prefix: string | null;
      sidebar_section: string;
      group_kind: string;
      nav_end: number;
    }[];
    expect(rows).toHaveLength(1);
    const node = rows[0]!;
    expect(node.parent_id).toBeNull();
    expect(node.route_path).toBe("/credit-cards");
    expect(node.active_prefix).toBe("/credit-cards");
    expect(node.sidebar_section).toBe("main");
    expect(node.group_kind).toBe("bucket");
    expect(node.nav_end).toBe(1);
  });
});

describe("seedNavTree retirement AFP+AFC", () => {
  it("links AFP and AFC accounts directly under retirement_afp_afc (no __afp/__afc nav groups)", () => {
    seedNavTree();
    const bucketId = (
      db.prepare(`SELECT id FROM portfolio_groups WHERE slug = 'retirement_afp_afc'`).get() as {
        id: number;
      }
    ).id;

    const childGroups = db
      .prepare(
        `SELECT c.slug FROM portfolio_group_items i
         JOIN portfolio_groups c ON c.id = i.child_group_id
         WHERE i.group_id = ? AND i.item_kind = 'group'`
      )
      .all(bucketId) as { slug: string }[];
    expect(childGroups).toEqual([]);

    const accountCount = (
      db
        .prepare(
          `SELECT COUNT(*) AS n FROM portfolio_group_items
           WHERE group_id = ? AND item_kind = 'account'`
        )
        .get(bucketId) as { n: number }
    ).n;
    expect(accountCount).toBeGreaterThanOrEqual(2);

    const orphanNavGroups = db
      .prepare(
        `SELECT slug FROM portfolio_groups WHERE slug IN ('retirement_afp_afc__afp', 'retirement_afp_afc__afc')`
      )
      .all() as { slug: string }[];
    expect(orphanNavGroups).toEqual([]);
  });
});

describe("seedNavTree retirement APV A", () => {
  it("links pre-Fintual APV-a principal under retirement_apv_a", () => {
    seedNavTree();
    const row = db
      .prepare(`SELECT id FROM accounts WHERE notes = 'import:excel|key=apv_a_principal'`)
      .get() as { id: number } | undefined;
    if (!row) return;

    const link = db
      .prepare(
        `SELECT pg.slug FROM portfolio_group_items i
         JOIN portfolio_groups pg ON pg.id = i.group_id
         WHERE i.account_id = ? AND i.item_kind = 'account'`
      )
      .get(row.id) as { slug: string } | undefined;
    expect(link?.slug).toBe("retirement_apv_a");

    const ag = db
      .prepare(
        `SELECT g.slug FROM accounts a JOIN asset_groups g ON g.id = a.asset_group_id WHERE a.id = ?`
      )
      .get(row.id) as { slug: string };
    expect(ag.slug).toBe("retirement_apv_a__apv");
  });
});
