/**
 * Account placement (`accountPlacement.ts`): the code that creates, moves, renames or deletes an
 * account writes its place in the net-worth tree; the boot seed places nothing. Synthetic fixtures
 * only (`vitest_placement_*` leaves and accounts), removed afterwards.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  accountBucketSlug,
  accountsMissingPlacement,
  assertAccountsPlaced,
  placeAccount,
  placeAllAccounts,
  removeAccountPlacement,
} from "./accountPlacement.js";
import { ensureChildAssetGroupId } from "./assetGroupTree.js";
import { clearAggregationCache } from "./cacheRegistry.js";
import { createPanelAccount, updatePanelAccount } from "./createPanelAccount.js";
import { db } from "./db.js";
import { getNetWorthNavGroupNode } from "./navTree.js";
import type { NavTreeNodeDto } from "./navTree.js";
import { leafGroupOfAccount } from "./navTreeModel.js";
import { seedNavTree } from "./seedNavTree.js";

const CATEGORY = "vitest_placement";
const cleanup: (() => void)[] = [];

afterEach(() => {
  for (const fn of cleanup.splice(0).reverse()) fn();
  db.prepare(`DELETE FROM asset_groups WHERE slug GLOB ?`).run(`*__${CATEGORY}*`);
  clearAggregationCache();
});

function dropAccount(accountId: number): void {
  removeAccountPlacement(accountId);
  db.prepare(`DELETE FROM accounts WHERE id = ?`).run(accountId);
}

/** A cash account created through the panel path in `bucketSlug`; removed after the test. */
function panelCashAccount(bucketSlug: string, name: string, suffix = ""): number {
  const { account_id } = createPanelAccount({
    account: {
      account_type: "clp_cash",
      name,
      category_slug: `${CATEGORY}${suffix}`,
      bucket_slug: bucketSlug,
      exclude_from_group_totals: false,
    },
  });
  cleanup.push(() => dropAccount(account_id));
  return account_id;
}

/** An account row written straight onto a leaf under `parentAssetSlug`, with no placement. */
function rawAccount(parentAssetSlug: string, name: string): number {
  const leaf = ensureChildAssetGroupId(parentAssetSlug, `${CATEGORY}__clp`, name);
  const id = Number(db.prepare(`INSERT INTO accounts (asset_group_id, name) VALUES (?, ?)`).run(leaf.id, name).lastInsertRowid);
  cleanup.push(() => dropAccount(id));
  return id;
}

const itemsOfAccount = (accountId: number) =>
  db
    .prepare(
      `SELECT g.slug FROM portfolio_group_items i JOIN portfolio_groups g ON g.id = i.group_id
       WHERE i.item_kind = 'account' AND i.account_id = ? ORDER BY g.slug`
    )
    .all(accountId)
    .map((r) => (r as { slug: string }).slug);

const edge = (parentSlug: string, childSlug: string) =>
  db
    .prepare(
      `SELECT i.sort_order FROM portfolio_group_items i
       JOIN portfolio_groups p ON p.id = i.group_id
       JOIN portfolio_groups c ON c.id = i.child_group_id
       WHERE i.item_kind = 'group' AND p.slug = ? AND c.slug = ?`
    )
    .get(parentSlug, childSlug) as { sort_order: number } | undefined;

const heldNamesInOrder = (groupSlug: string) =>
  db
    .prepare(
      `SELECT COALESCE(a.name, c.label) AS name, i.sort_order FROM portfolio_group_items i
       JOIN portfolio_groups g ON g.id = i.group_id
       LEFT JOIN accounts a ON a.id = i.account_id
       LEFT JOIN portfolio_groups c ON c.id = i.child_group_id
       WHERE g.slug = ? AND i.item_kind IN ('account', 'group') ORDER BY i.sort_order, i.id`
    )
    .all(groupSlug) as { name: string; sort_order: number }[];

function findNode(node: NavTreeNodeDto | null, slug: string): NavTreeNodeDto | null {
  if (!node) return null;
  if (node.slug === slug) return node;
  for (const child of node.children ?? []) {
    const hit = findNode(child, slug);
    if (hit) return hit;
  }
  return null;
}

const snapshot = () => ({
  items: db.prepare(`SELECT * FROM portfolio_group_items ORDER BY id`).all(),
  primary: db.prepare(`SELECT id, primary_portfolio_group_id FROM accounts ORDER BY id`).all(),
});

describe("a panel account takes its place when it is created", () => {
  it("appears in the tree without the seed having run, and links a bucket that held nothing", () => {
    // The Vitest person holds no crypto: Brokerage does not list the bucket until an account sits in it.
    expect(edge("brokerage", "brokerage_crypto")).toBeUndefined();
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    let accountId: number;
    try {
      accountId = panelCashAccount("brokerage_crypto", "vitest placement wallet");
      expect(log.mock.calls.flat().some((line) => String(line).includes("nav tree: seeded"))).toBe(false);
    } finally {
      log.mockRestore();
    }

    expect(itemsOfAccount(accountId)).toEqual(["brokerage_crypto"]);
    expect(edge("brokerage", "brokerage_crypto")).toEqual({ sort_order: 20 });
    expect(leafGroupOfAccount(accountId)?.slug).toBe("brokerage_crypto");
    const primary = db
      .prepare(
        `SELECT g.slug FROM accounts a JOIN portfolio_groups g ON g.id = a.primary_portfolio_group_id WHERE a.id = ?`
      )
      .get(accountId);
    expect(primary).toEqual({ slug: "brokerage_crypto" });

    clearAggregationCache();
    const nw = getNetWorthNavGroupNode();
    expect(findNode(nw, "brokerage_crypto")?.member_account_ids).toEqual([accountId]);
    expect((findNode(nw, "brokerage")?.children ?? []).map((c) => c.slug)).toContain("brokerage_crypto");
    expect(accountsMissingPlacement()).toEqual([]);
  });

  it("a move leaves the old bucket (unlinked once empty) and a rename re-orders the new one", () => {
    const accountId = panelCashAccount("brokerage_crypto", "vitest placement mover");
    expect(edge("brokerage", "brokerage_crypto")).toBeDefined();

    updatePanelAccount(accountId, { bucket_slug: "cash_savings" });
    expect(itemsOfAccount(accountId)).toEqual(["cash_savings"]);
    expect(edge("brokerage", "brokerage_crypto")).toBeUndefined();

    const sortedByName = (rows: { name: string }[]) =>
      [...rows].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" })).map((r) => r.name);
    const afterMove = heldNamesInOrder("cash_savings");
    expect(afterMove.map((r) => r.name)).toEqual(sortedByName(afterMove));
    expect(afterMove.map((r) => r.sort_order)).toEqual(afterMove.map((_, i) => i * 10));

    updatePanelAccount(accountId, { name: "000 vitest placement first" });
    const afterRename = heldNamesInOrder("cash_savings");
    expect(afterRename[0]?.name).toBe("000 vitest placement first");
    expect(afterRename.map((r) => r.sort_order)).toEqual(afterRename.map((_, i) => i * 10));
  });

  it("a deleted account's bucket is unlinked when it was its last item", () => {
    const { account_id } = createPanelAccount({
      account: {
        account_type: "clp_cash",
        name: "vitest placement gone",
        category_slug: CATEGORY,
        bucket_slug: "brokerage_crypto",
        exclude_from_group_totals: false,
      },
    });
    expect(edge("brokerage", "brokerage_crypto")).toBeDefined();
    dropAccount(account_id);
    expect(edge("brokerage", "brokerage_crypto")).toBeUndefined();
  });
});

describe("the seed places no account", () => {
  it("leaves an unplaced account where it is; the placement check names it", () => {
    const before = snapshot();
    const accountId = rawAccount("cash_eqs__cash_savings", "vitest placement unplaced");
    seedNavTree();
    expect(itemsOfAccount(accountId)).toEqual([]);

    const missing = accountsMissingPlacement();
    expect(missing).toEqual([
      {
        accountId,
        assetGroupSlug: `cash_eqs__cash_savings__${CATEGORY}__clp`,
        bucketSlug: "cash_savings",
        storedGroupSlug: null,
      },
    ]);
    expect(() => assertAccountsPlaced()).toThrow(new RegExp(`account ${accountId} on .* belongs in cash_savings, stored in no group`));

    placeAccount(accountId);
    expect(itemsOfAccount(accountId)).toEqual(["cash_savings"]);
    expect(() => assertAccountsPlaced()).not.toThrow();

    dropAccount(accountId);
    expect(snapshot()).toEqual(before);
  });

  it("placing every account again changes nothing on a placed database", () => {
    // A first pass settles what a fixture of another file left (a gap where it deleted an account row).
    placeAllAccounts();
    const before = snapshot();
    placeAllAccounts();
    expect(snapshot()).toEqual(before);
    expect(accountsMissingPlacement()).toEqual([]);
  });
});

describe("an account no bucket holds", () => {
  it("is refused: a leaf straight under a hub, a liability, an asset group with sub-groups", () => {
    const underHub = rawAccount("brokerage", "vitest placement under hub");
    expect(accountBucketSlug(underHub)).toBeNull();
    expect(() => placeAccount(underHub)).toThrow(/which no bucket of the net-worth tree holds/);

    const liability = rawAccount("liabilities", "vitest placement liability");
    expect(() => placeAccount(liability)).toThrow(/which no bucket of the net-worth tree holds/);
    // Neither is the tree's to place, so neither is missing from it.
    expect(accountsMissingPlacement()).toEqual([]);

    const onParent = Number(
      db
        .prepare(`INSERT INTO accounts (asset_group_id, name) SELECT id, 'vitest placement on parent' FROM asset_groups WHERE slug = 'cash_eqs__cash_savings'`)
        .run().lastInsertRowid
    );
    cleanup.push(() => dropAccount(onParent));
    expect(() => placeAccount(onParent)).toThrow(/has sub-groups/);
  });
});
