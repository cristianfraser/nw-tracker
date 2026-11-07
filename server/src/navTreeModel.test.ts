import { afterEach, describe, expect, it } from "vitest";
import { db } from "./db.js";
import {
  bucketOfAccount,
  chartHostOfGroup,
  groupAccountIds,
  investmentRootSlugs,
  isInvestmentGroup,
  isInvestmentRootsHub,
  leafGroupOfAccount,
  liabilityGroups,
  navGroup,
  netsLinkedGroup,
  nettedGroup,
  nwBucketSlugs,
} from "./navTreeModel.js";
import { seedNavTree } from "./seedNavTree.js";

const PREFIX = "vitest_navmodel";

function insertGroup(slug: string, parentSlug: string | null, extra: Record<string, unknown> = {}): number {
  const parentId = parentSlug
    ? (db.prepare(`SELECT id FROM portfolio_groups WHERE slug = ?`).get(parentSlug) as { id: number }).id
    : null;
  const cols = ["slug", "label", "parent_id", "group_kind", ...Object.keys(extra)];
  const vals = [slug, slug, parentId, "bucket", ...Object.values(extra)];
  const id = Number(
    db.prepare(`INSERT INTO portfolio_groups (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`).run(...vals)
      .lastInsertRowid
  );
  if (parentId != null) {
    db.prepare(`INSERT INTO portfolio_group_items (group_id, item_kind, child_group_id, sort_order) VALUES (?, 'group', ?, 0)`).run(
      parentId,
      id
    );
  }
  return id;
}

function insertAccount(name: string, groupId: number): number {
  const id = Number(
    db
      .prepare(`INSERT INTO accounts (asset_group_id, name, import_key) SELECT id, ?, ? FROM asset_groups ORDER BY id LIMIT 1`)
      .run(name, `${PREFIX}|${name}`).lastInsertRowid
  );
  db.prepare(`INSERT INTO portfolio_group_items (group_id, item_kind, account_id, sort_order) VALUES (?, 'account', ?, 0)`).run(groupId, id);
  return id;
}

afterEach(() => {
  db.prepare(`DELETE FROM accounts WHERE import_key LIKE ?`).run(`${PREFIX}|%`);
  db.prepare(`DELETE FROM portfolio_groups WHERE slug LIKE ?`).run(`${PREFIX}%`);
});

describe("navTreeModel on the seeded tree", () => {
  it("reads the roles as data", () => {
    seedNavTree();
    expect(nwBucketSlugs()).toEqual(["real_estate", "retirement", "brokerage", "cash_eqs"]);
    expect(investmentRootSlugs()).toEqual(["retirement", "brokerage"]);
    expect(netsLinkedGroup("cash_eqs")?.slug).toBe("liabilities_credit_card");
    expect(netsLinkedGroup("cash_savings")?.slug).toBe("liabilities_credit_card");
    expect(netsLinkedGroup("checking_accounts")).toBeNull();
    expect(nettedGroup().slug).toBe("liabilities_credit_card");
    expect(isInvestmentRootsHub("inversiones")).toBe(true);
    expect(isInvestmentRootsHub("net_worth")).toBe(false);
  });

  it("resolves each page's chart host from the reference groups and the netting", () => {
    seedNavTree();
    expect(chartHostOfGroup("cash_eqs")).toBe("cash_eqs");
    expect(chartHostOfGroup("cash_savings")).toBe("cash_eqs");
    expect(chartHostOfGroup("checking_accounts")).toBeNull();
    expect(chartHostOfGroup("liabilities")).toBe("liabilities");
    expect(chartHostOfGroup("liabilities_credit_card")).toBeNull();
    expect(chartHostOfGroup("brokerage")).toBeNull();
  });

  it("attaches the Pasivos subtree: its groups hold the liability items", () => {
    seedNavTree();
    const groups = liabilityGroups();
    expect(groups.map((g) => g.liabilityKind)).toEqual(["credit_card", "mortgage"]);
    const cards = db
      .prepare(
        `SELECT i.account_id FROM liability_group_items i JOIN liability_groups g ON g.id = i.group_id
         WHERE g.slug = 'liabilities_credit_card' ORDER BY i.account_id`
      )
      .all() as { account_id: number }[];
    expect(groupAccountIds("liabilities_credit_card")).toEqual(cards.map((r) => r.account_id));
  });
});

describe("navTreeModel on a synthetic subtree", () => {
  it("walks membership, totals and buckets from the items", () => {
    seedNavTree();
    const hub = insertGroup(`${PREFIX}_hub`, "brokerage");
    const kept = insertGroup(`${PREFIX}_kept`, `${PREFIX}_hub`);
    const excluded = insertGroup(`${PREFIX}_excluded`, `${PREFIX}_hub`, { exclude_from_parent_total: 1 });
    const a = insertAccount("a", hub);
    const b = insertAccount("b", kept);
    const c = insertAccount("c", excluded);

    expect(groupAccountIds(`${PREFIX}_hub`)).toEqual([a, b, c]);
    expect(groupAccountIds(`${PREFIX}_hub`, { forTotals: true })).toEqual([a, b]);
    expect(leafGroupOfAccount(b)?.slug).toBe(`${PREFIX}_kept`);
    expect(bucketOfAccount(c)).toBe("brokerage");
    expect(isInvestmentGroup(`${PREFIX}_kept`)).toBe(true);
    expect(navGroup(`${PREFIX}_kept`)?.nwBucket).toBe(false);
  });

  it("throws on an account that is an item of two groups", () => {
    seedNavTree();
    const one = insertGroup(`${PREFIX}_one`, "brokerage");
    const two = insertGroup(`${PREFIX}_two`, "brokerage");
    const a = insertAccount("twice", one);
    db.prepare(`INSERT INTO portfolio_group_items (group_id, item_kind, account_id, sort_order) VALUES (?, 'account', ?, 0)`).run(two, a);
    expect(() => groupAccountIds("brokerage")).toThrow(/item of two groups/);
  });
});
