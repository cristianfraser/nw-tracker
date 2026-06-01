import { afterEach, describe, expect, it } from "vitest";
import { db } from "./db.js";
import {
  clearPortfolioGroupColorCache,
  resolvePortfolioGroupColorRgb,
  resolvePortfolioGroupColorRgbBySlug,
} from "./chartColorRgb.js";

function insertGroup(slug: string, color_rgb: string | null = null): number {
  db.prepare(
    `INSERT INTO portfolio_groups (slug, label, sort_order, color_rgb)
     VALUES (?, ?, 0, ?)`
  ).run(slug, slug, color_rgb);
  return (db.prepare(`SELECT id FROM portfolio_groups WHERE slug = ?`).get(slug) as { id: number })
    .id;
}

function linkGroupChild(parentId: number, childGroupId: number, sort = 0): void {
  db.prepare(
    `INSERT INTO portfolio_group_items (group_id, item_kind, child_group_id, sort_order)
     VALUES (?, 'group', ?, ?)`
  ).run(parentId, childGroupId, sort);
}

function linkAccount(parentId: number, accountId: number, sort = 0): void {
  db.prepare(
    `INSERT INTO portfolio_group_items (group_id, item_kind, account_id, sort_order)
     VALUES (?, 'account', ?, ?)`
  ).run(parentId, accountId, sort);
}

function insertAccount(color_rgb: string | null, balance: number): number {
  db.prepare(
    `INSERT INTO accounts (name, notes, asset_group_id, color_rgb)
     VALUES ('test', NULL, (SELECT id FROM asset_groups LIMIT 1), ?)`
  ).run(color_rgb);
  const id = (db.prepare(`SELECT id FROM accounts ORDER BY id DESC LIMIT 1`).get() as { id: number })
    .id;
  db.prepare(`INSERT INTO valuations (account_id, as_of_date, value_clp) VALUES (?, '2026-01-31', ?)`).run(
    id,
    balance
  );
  return id;
}

describe("resolvePortfolioGroupColorRgb", () => {
  afterEach(() => {
    clearPortfolioGroupColorCache();
  });

  it("uses explicit color when set", () => {
    const id = insertGroup(`pg_explicit_${Date.now()}`, "10,20,30");
    expect(resolvePortfolioGroupColorRgb(id)).toBe("10,20,30");
  });

  it("picks largest direct child group by total balance and resolves recursively", () => {
    const ts = Date.now();
    const parentId = insertGroup(`pg_parent_${ts}`);
    const smallChildId = insertGroup(`pg_small_${ts}`);
    const largeChildId = insertGroup(`pg_large_${ts}`);

    const red = insertAccount("255,0,0", 40);
    const green = insertAccount("0,255,0", 60);
    const blue = insertAccount("0,0,255", 500);

    linkGroupChild(parentId, smallChildId);
    linkGroupChild(parentId, largeChildId, 1);
    linkAccount(smallChildId, red);
    linkAccount(smallChildId, green, 1);
    linkAccount(largeChildId, blue);

    clearPortfolioGroupColorCache();
    expect(resolvePortfolioGroupColorRgb(parentId)).toBe("0,0,255");
  });

  it("inherits from largest account within winning unset child group", () => {
    const ts = Date.now();
    const parentId = insertGroup(`pg_parent2_${ts}`);
    const childId = insertGroup(`pg_child2_${ts}`);

    const small = insertAccount("255,0,0", 100);
    const large = insertAccount("0,128,0", 300);

    linkGroupChild(parentId, childId);
    linkAccount(childId, small);
    linkAccount(childId, large, 1);

    clearPortfolioGroupColorCache();
    expect(resolvePortfolioGroupColorRgb(parentId)).toBe("0,128,0");
  });

  it("resolvePortfolioGroupColorRgbBySlug returns recursive color", () => {
    const ts = Date.now();
    const slug = `pg_by_slug_${ts}`;
    const parentId = insertGroup(slug);
    const acc = insertAccount("200,100,50", 1000);
    linkAccount(parentId, acc);

    clearPortfolioGroupColorCache();
    expect(resolvePortfolioGroupColorRgbBySlug(slug)).toBe("200,100,50");
  });
});
