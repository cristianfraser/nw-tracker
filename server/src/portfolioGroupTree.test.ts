import { describe, expect, it } from "vitest";
import { seedNavTree } from "./seedNavTree.js";
import { db } from "./db.js";
import {
  accountIdsInPortfolioGroup,
  assetGroupIdForImportKind,
  accountIdsInPortfolioGroupForTotals,
  portfolioGroupBySlug,
} from "./portfolioGroupTree.js";
import { bucketOfAccount } from "./navTreeModel.js";

describe("portfolioGroupTree", () => {
  it("lists AFP and AFC under retirement_afp_afc portfolio group", () => {
    seedNavTree();
    const ids = accountIdsInPortfolioGroup("retirement_afp_afc");
    // The Vitest person holds one AFP account (UNO-A) and the AFC: each filed under its own leaf.
    const leafSlugs = ids.map(
      (id) =>
        (
          db
            .prepare(`SELECT g.slug FROM accounts a JOIN asset_groups g ON g.id = a.asset_group_id WHERE a.id = ?`)
            .get(id) as { slug: string }
        ).slug
    );
    expect(leafSlugs.sort()).toEqual(["retirement_afp_afc__afc", "retirement_afp_afc__afp"]);
  });

  it("resolves import kind afc to leaf asset group, not parent bucket", () => {
    seedNavTree();
    const agId = assetGroupIdForImportKind("afc");
    const bySlug = (slug: string) =>
      (db.prepare(`SELECT id FROM asset_groups WHERE slug = ?`).get(slug) as { id: number }).id;
    expect(agId).toBe(bySlug("retirement_afp_afc__afc"));
    expect(agId).not.toBe(bySlug("retirement_afp_afc"));
  });

  it("rolls up brokerage total from nested portfolio groups (tree, not per-account slug tags)", () => {
    seedNavTree();
    const mfAccount = db
      .prepare(
        `SELECT a.id FROM accounts a
         JOIN portfolio_groups pg ON pg.id = a.primary_portfolio_group_id
         WHERE pg.slug = 'brokerage_mutual_funds'
         LIMIT 1`
      )
      .get() as { id: number } | undefined;
    // The Vitest person's fund («Fondo Moderado», `testPerson` fund).
    expect(mfAccount).toBeDefined();
    expect(bucketOfAccount(mfAccount!.id)).toBe("brokerage");
    const broIds = new Set(accountIdsInPortfolioGroupForTotals("brokerage"));
    expect(broIds.has(mfAccount!.id)).toBe(true);
  });

  it("marks checking_accounts as a leaf bucket under cash_eqs", () => {
    seedNavTree();
    const checking = portfolioGroupBySlug("checking_accounts");
    expect(checking?.group_kind).toBe("bucket");
    expect(checking?.exclude_from_parent_total).toBe(0);
  });
});
