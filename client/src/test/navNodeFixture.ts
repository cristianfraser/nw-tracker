import type { NavTreeNodeDto } from "../types";

/**
 * Full-default NavTreeNodeDto for tests: DTO fields are required (matching the server
 * payload), so partial literals break whenever the nav contract grows. Spread overrides
 * over these defaults instead of hand-writing every field per test.
 */
export function navNodeFixture(
  partial: Partial<NavTreeNodeDto> & Pick<NavTreeNodeDto, "slug" | "label">
): NavTreeNodeDto {
  return {
    node_id: `node-${partial.slug}`,
    label_i18n_key: null,
    route_path: `/group/${partial.slug}`,
    active_prefix: null,
    nav_end: false,
    show_leaf_hyphen: false,
    account_id: null,
    portfolio_group_id: null,
    source_account_id: null,
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
