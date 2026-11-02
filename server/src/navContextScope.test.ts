import { describe, expect, it } from "vitest";
import type { NavTreeNodeDto } from "./navTree.js";
import { navContextScope, valueMapSubtree } from "./navContextScope.js";
import type { NavValueMapNodeDto } from "./navValueMap.js";

function group(slug: string, children: NavTreeNodeDto[], extra: Partial<NavTreeNodeDto> = {}): NavTreeNodeDto {
  return {
    slug,
    account_id: null,
    expense_account_id: null,
    member_account_ids: [],
    children,
    ...extra,
  } as unknown as NavTreeNodeDto;
}

function account(id: number, expenseAccountId: number | null = null): NavTreeNodeDto {
  return {
    slug: `account_${id}`,
    account_id: id,
    expense_account_id: expenseAccountId,
    children: [],
  } as unknown as NavTreeNodeDto;
}

const cards = group("liabilities_credit_card", [account(40, 41)], { member_account_ids: [40, 41] });
// Like the real Pasivos root: its own node lists no member accounts, its children do.
const liabilities = group("liabilities", [cards, group("liabilities_mortgage", [account(50)], { member_account_ids: [50] })], {
  member_account_ids: undefined,
});
const cash = group("cash_eqs", [group("cash_savings", [account(1)], { member_account_ids: [1, 2] })], {
  member_account_ids: [1, 2],
  linked_card_slugs: ["liabilities_credit_card"],
});
const brokerage = group("brokerage", [group("brokerage_acciones", [account(10)], { member_account_ids: [10] })], {
  member_account_ids: [10],
});
// The net worth tree carries a childless `liabilities` node; the Pasivos page is the full one.
const netWorth = group("net_worth", [cash, brokerage, group("liabilities", [])], { member_account_ids: [1, 2, 10] });

describe("navContextScope", () => {
  it("keeps the page's subtree, every member account and the liability accounts", () => {
    const scope = navContextScope("brokerage", [liabilities, netWorth], liabilities);
    expect([...scope.slugs].sort()).toEqual(["account_10", "brokerage", "brokerage_acciones"]);
    expect([...scope.accountIds].sort((a, b) => a - b)).toEqual([10, 40, 41, 50]);
  });

  it("adds the subtrees of the groups a node hosts as cards", () => {
    const scope = navContextScope("cash_eqs", [liabilities, netWorth], liabilities);
    expect(scope.slugs.has("liabilities_credit_card")).toBe(true);
    expect(scope.slugs.has("account_40")).toBe(true);
    expect(scope.slugs.has("brokerage")).toBe(false);
    // A chart-inactive leaf the tree omits still counts through member_account_ids.
    expect(scope.accountIds.has(2)).toBe(true);
  });

  it("finds the Pasivos page in the Pasivos tree, not the net worth stub", () => {
    const scope = navContextScope("liabilities", [liabilities, netWorth], liabilities);
    expect(scope.slugs.has("liabilities_mortgage")).toBe(true);
  });

  it("refuses a slug the tree does not have", () => {
    expect(() => navContextScope("nope", [liabilities, netWorth], liabilities)).toThrow(/no nav node/);
  });
});

describe("valueMapSubtree", () => {
  const tile = (slug: string, kind: NavValueMapNodeDto["kind"] = "group") =>
    ({ slug, kind, children: [] }) as unknown as NavValueMapNodeDto;
  const map = { ...tile("net_worth"), children: [{ ...tile("brokerage"), children: [tile("account_10", "account")] }] } as NavValueMapNodeDto;

  it("returns the page's group and nothing for an unknown one", () => {
    expect(valueMapSubtree(map, "brokerage")?.slug).toBe("brokerage");
    expect(valueMapSubtree(map, "account_10")).toBeUndefined();
    expect(valueMapSubtree(undefined, "brokerage")).toBeUndefined();
  });
});
