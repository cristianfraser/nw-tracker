import { describe, expect, it } from "vitest";
import {
  buildPlaceholderAccountDetailBundle,
  placeholderCategorySlug,
} from "./accountDetailPlaceholders";
import type { NavTreeNodeDto } from "../types";

function navNode(partial: Partial<NavTreeNodeDto> & { account_id: number; label: string }): NavTreeNodeDto {
  return {
    node_id: `acc.${partial.account_id}`,
    slug: `account_${partial.account_id}`,
    label_i18n_key: null,
    route_path: `/account/${partial.account_id}`,
    active_prefix: null,
    nav_end: true,
    show_leaf_hyphen: true,
    portfolio_group_id: null,
    expense_account_id: null,
    expense_account_slug: null,
    asset_group_slug: null,
    kind_slug: null,
    dashboard_bucket_slug: null,
    api_group: null,
    api_subgroup: null,
    color_rgb: null,
    color: null,
    group_kind: "bucket",
    children: [],
    ...partial,
  };
}

describe("placeholderCategorySlug", () => {
  it("reads the account's kind from the card row's leaf asset-group slug", () => {
    expect(placeholderCategorySlug({ dashRow: { name: "x", bucket_slug: "retirement_afp_afc__afp" } })).toBe("afp");
    expect(placeholderCategorySlug({ dashRow: { name: "x", bucket_slug: "cash_eqs__cuenta_corriente" } })).toBe(
      "cuenta_corriente"
    );
    expect(placeholderCategorySlug({ dashRow: { name: "x", bucket_slug: "brokerage_cash__usd" } })).toBe("usd");
    expect(
      placeholderCategorySlug({
        dashRow: { name: "x", bucket_slug: "brokerage_cash__caja_portafolio_ipsa__clp" },
      })
    ).toBe("clp");
  });

  it("prefers the row's own category_slug over its bucket slug", () => {
    expect(
      placeholderCategorySlug({
        dashRow: { name: "x", bucket_slug: "real_estate__property", category_slug: "property" },
      })
    ).toBe("property");
  });

  it("does not read a kind off a plain account leaf of the sidebar tree (only its group has one)", () => {
    const leaf = navNode({ account_id: 22, label: "Cuenta" });
    expect(placeholderCategorySlug({ navNode: leaf })).toBe("mutual_fund");
  });

  it("names the liability leaves from the nav node alone", () => {
    const card = navNode({
      account_id: 32,
      label: "card",
      asset_group_slug: "credit_cards",
      api_subgroup: "credit_card",
    });
    const mortgage = navNode({
      account_id: 84,
      label: "mortgage",
      asset_group_slug: "liabilities",
      api_subgroup: "mortgage",
    });
    expect(placeholderCategorySlug({ navNode: card })).toBe("credit_card");
    expect(placeholderCategorySlug({ navNode: mortgage })).toBe("mortgage");
  });

  it("takes an enriched leaf's kind_slug as the category", () => {
    expect(placeholderCategorySlug({ navNode: navNode({ account_id: 5, label: "x", kind_slug: "bitcoin" }) })).toBe(
      "bitcoin"
    );
  });

  it("falls back to the generic investment frame when nothing identifies the account", () => {
    expect(placeholderCategorySlug()).toBe("mutual_fund");
    expect(placeholderCategorySlug({ navNode: null, dashRow: null })).toBe("mutual_fund");
  });
});

describe("buildPlaceholderAccountDetailBundle", () => {
  it("carries the nav-derived category into the summary and the monthly performance", () => {
    const bundle = buildPlaceholderAccountDetailBundle(78, "clp", {
      navNode: navNode({ account_id: 78, label: "AFP UNO" }),
      dashRow: { name: "AFP UNO", bucket_slug: "retirement_afp_afc__afp" },
    });
    expect(bundle.summary.category_slug).toBe("afp");
    expect(bundle.monthly_performance?.category_slug).toBe("afp");
    expect(bundle.summary.account_id).toBe(78);
  });

  it("titles the page from the nav node, then the card row, else blank", () => {
    expect(
      buildPlaceholderAccountDetailBundle(7, "clp", {
        navNode: navNode({ account_id: 7, label: "From nav" }),
        dashRow: { name: "From row", bucket_slug: "cash_eqs__dap" },
      }).ts?.name
    ).toBe("From nav");
    expect(
      buildPlaceholderAccountDetailBundle(7, "clp", { dashRow: { name: "From row", bucket_slug: "cash_eqs__dap" } }).ts
        ?.name
    ).toBe("From row");
    expect(buildPlaceholderAccountDetailBundle(7, "clp").ts?.name).toBe("");
  });

  it("keeps the ledgers empty, the capability schemas absent and the unit of the request", () => {
    const bundle = buildPlaceholderAccountDetailBundle(3, "usd");
    expect(bundle.ts?.unit).toBe("usd");
    expect(bundle.summary.movement_create).toBeUndefined();
    expect(bundle.summary.book_ledger_edit).toBeUndefined();
    expect(bundle.summary.mortgage_payment_create).toBeUndefined();
    expect(bundle.mortgageLedger.rows).toEqual([]);
    expect(bundle.ccLedger.purchases).toEqual([]);
    expect(bundle.depositInflows.state_contribution_events).toEqual([]);
  });
});
