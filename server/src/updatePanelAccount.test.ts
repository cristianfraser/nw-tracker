import { describe, expect, it } from "vitest";
import { db } from "./db.js";
import { createPanelAccount, updatePanelAccount } from "./createPanelAccount.js";
import { accountKindSlugForAccountId } from "./accountBucket.js";

function accountRow(accountId: number) {
  return db
    .prepare(
      `SELECT a.name, g.slug AS bucket_slug
       FROM accounts a JOIN asset_groups g ON g.id = a.asset_group_id WHERE a.id = ?`
    )
    .get(accountId) as { name: string; bucket_slug: string };
}

function navBucketSlugsForAccount(accountId: number): string[] {
  return (
    db
      .prepare(
        `SELECT pg.slug FROM portfolio_group_items pgi
         JOIN portfolio_groups pg ON pg.id = pgi.group_id
         WHERE pgi.account_id = ?`
      )
      .all(accountId) as { slug: string }[]
  ).map((r) => r.slug);
}

function createFixtureAccount(categorySlug: string, bucketSlug: string) {
  return createPanelAccount({
    account: {
      account_type: "clp_cash",
      name: `Vitest edit ${categorySlug}`,
      category_slug: categorySlug,
      bucket_slug: bucketSlug,
      exclude_from_group_totals: false,
    },
  });
}

function cleanup(accountId: number, assetGroupIds: number[]) {
  db.prepare(`DELETE FROM accounts WHERE id = ?`).run(accountId);
  for (const id of assetGroupIds) {
    db.prepare(`DELETE FROM asset_groups WHERE id = ?`).run(id);
  }
}

describe("updatePanelAccount", () => {
  it("renames an account without touching its bucket", () => {
    const slug = `vitest_edit_ren_${Date.now()}`;
    const created = createFixtureAccount(slug, "cash_savings");
    try {
      const result = updatePanelAccount(created.account_id, { name: "  Renombrada  " });
      expect(result.name).toBe("Renombrada");
      expect(result.asset_group_id).toBe(created.asset_group_id);
      expect(result.created_leaf_bucket).toBe(false);
      const acc = accountRow(created.account_id);
      expect(acc.name).toBe("Renombrada");
      expect(acc.bucket_slug).toBe(`cash_eqs__cash_savings__${slug}__clp`);
    } finally {
      cleanup(created.account_id, [created.asset_group_id]);
    }
  });

  it("moves an account to another bucket, preserving the behavior kind and relinking the nav", () => {
    const slug = `vitest_edit_mv_${Date.now()}`;
    const created = createFixtureAccount(slug, "cash_savings");
    const extraGroups: number[] = [];
    try {
      expect(navBucketSlugsForAccount(created.account_id)).toContain("cash_savings");
      const kindBefore = accountKindSlugForAccountId(created.account_id);

      const result = updatePanelAccount(created.account_id, { bucket_slug: "brokerage_acciones" });
      if (result.asset_group_id !== created.asset_group_id) extraGroups.push(result.asset_group_id);
      expect(result.bucket_slug).toBe(`brokerage_acciones__${slug}__clp`);

      const acc = accountRow(created.account_id);
      expect(acc.bucket_slug).toBe(`brokerage_acciones__${slug}__clp`);
      expect(accountKindSlugForAccountId(created.account_id)).toBe(kindBefore);

      const navSlugs = navBucketSlugsForAccount(created.account_id);
      expect(navSlugs).toContain("brokerage_acciones");
      expect(navSlugs).not.toContain("cash_savings");
    } finally {
      cleanup(created.account_id, [created.asset_group_id, ...extraGroups]);
    }
  });

  it("renames and moves in one call", () => {
    const slug = `vitest_edit_both_${Date.now()}`;
    const created = createFixtureAccount(slug, "cash_savings");
    const extraGroups: number[] = [];
    try {
      const result = updatePanelAccount(created.account_id, {
        name: "Movida y renombrada",
        bucket_slug: "brokerage_acciones",
      });
      if (result.asset_group_id !== created.asset_group_id) extraGroups.push(result.asset_group_id);
      const acc = accountRow(created.account_id);
      expect(acc.name).toBe("Movida y renombrada");
      expect(acc.bucket_slug).toBe(`brokerage_acciones__${slug}__clp`);
    } finally {
      cleanup(created.account_id, [created.asset_group_id, ...extraGroups]);
    }
  });

  it("treats a move to the current bucket as a no-op", () => {
    const slug = `vitest_edit_noop_${Date.now()}`;
    const created = createFixtureAccount(slug, "cash_savings");
    try {
      const result = updatePanelAccount(created.account_id, { bucket_slug: "cash_savings" });
      expect(result.asset_group_id).toBe(created.asset_group_id);
      expect(result.created_leaf_bucket).toBe(false);
    } finally {
      cleanup(created.account_id, [created.asset_group_id]);
    }
  });

  it("rejects invalid input", () => {
    const slug = `vitest_edit_bad_${Date.now()}`;
    const created = createFixtureAccount(slug, "cash_savings");
    try {
      expect(() => updatePanelAccount(created.account_id, {})).toThrow(/nothing to update/);
      expect(() => updatePanelAccount(created.account_id, { name: "   " })).toThrow(/non-empty/);
      expect(() => updatePanelAccount(created.account_id, { bucket_slug: "nope_missing" })).toThrow(
        /unknown bucket/
      );
      expect(() => updatePanelAccount(999999999, { name: "x" })).toThrow(/not found/);
    } finally {
      cleanup(created.account_id, [created.asset_group_id]);
    }
  });

  it("rejects moving a credit-card account", () => {
    const cc = db
      .prepare(
        `SELECT a.id FROM accounts a
         JOIN asset_groups g ON g.id = a.asset_group_id
         WHERE g.slug = 'credit_cards__credit_card' AND a.account_kind != 'liability_view'
         LIMIT 1`
      )
      .get() as { id: number } | undefined;
    if (!cc) return; // fixture DB always seeds CC masters; guard for lean presets
    expect(() => updatePanelAccount(cc.id, { bucket_slug: "cash_savings" })).toThrow(
      /credit-card accounts cannot move/
    );
  });
});
