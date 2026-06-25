import { describe, expect, it } from "vitest";
import { seedNavTree } from "./seedNavTree.js";
import { getDashboardLayoutCards } from "./dashboardLayout.js";

describe("getDashboardLayoutCards", () => {
  it("unwraps nav_bucket children for net worth cards", () => {
    seedNavTree();
    const cards = getDashboardLayoutCards();
    const slugs = cards.map((c) => c.slug);
    expect(slugs).toContain("real_estate");
    expect(slugs).toContain("brokerage");
    expect(slugs).toContain("retirement");
    expect(slugs).toContain("cash_eqs");
    expect(slugs).not.toContain("inversiones");
    expect(slugs).not.toContain("cash_savings");
    expect(slugs).not.toContain("checking_accounts");
  });
});
