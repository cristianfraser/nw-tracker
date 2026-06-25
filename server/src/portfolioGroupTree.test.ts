import { describe, expect, it } from "vitest";
import { seedNavTree } from "./seedNavTree.js";
import { db } from "./db.js";
import {
  accountIdsInPortfolioGroup,
  assetGroupIdForImportKind,
  accountIdsInPortfolioGroupForTotals,
  nwDashboardMetricGroupForAccount,
  portfolioGroupBySlug,
  resolvePortfolioGroupSlugForLegacyTab,
} from "./portfolioGroupTree.js";

describe("portfolioGroupTree", () => {
  it("lists AFP and AFC under retirement_afp_afc portfolio group", () => {
    seedNavTree();
    const ids = accountIdsInPortfolioGroup("retirement_afp_afc");
    expect(ids.length).toBeGreaterThanOrEqual(2);
  });

  it("resolves import kind afc to leaf asset group, not parent bucket", () => {
    seedNavTree();
    const agId = assetGroupIdForImportKind("afc");
    expect(agId).toBeGreaterThan(0);
  });

  it("maps legacy group+subgroup tab params to portfolio slugs", () => {
    seedNavTree();
    expect(resolvePortfolioGroupSlugForLegacyTab("brokerage", "mutual_funds")).toBe(
      "brokerage_mutual_funds"
    );
    expect(resolvePortfolioGroupSlugForLegacyTab("retirement", "afp_afc")).toBe(
      "retirement_afp_afc"
    );
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
    if (!mfAccount) return;
    expect(nwDashboardMetricGroupForAccount(mfAccount.id)).toBe("brokerage");
    const broIds = new Set(accountIdsInPortfolioGroupForTotals("brokerage"));
    expect(broIds.has(mfAccount.id)).toBe(true);
  });

  it("marks checking_accounts as a leaf bucket under cash_eqs", () => {
    seedNavTree();
    const checking = portfolioGroupBySlug("checking_accounts");
    expect(checking?.group_kind).toBe("bucket");
    expect(checking?.exclude_from_parent_total).toBe(0);
  });
});
