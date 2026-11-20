/** The nav tree's wire shapes: a node and the grouped chart lines its page draws. */
/** Client projection of `ChartBucketMeta` (groupChartBuckets.ts) — one grouped chart line, emitted on the nav tree. */
export type ChartBucketLineMetaDto = {
  data_key: string;
  /** Synthetic negative account id — same id the real grouped block's line carries. */
  account_id: number;
  dep_key: string;
  bar_data_key: string;
  name: string;
  name_i18n_key: string | null;
  color_rgb: string | null;
};

export type NavNodeChartBucketsDto = {
  grouped?: ChartBucketLineMetaDto[];
  ungrouped?: ChartBucketLineMetaDto[];
  /** Pasivos pages: single grouped mode, no Agrupado toggle. */
  liab?: ChartBucketLineMetaDto[];
};

export type NavTreeNodeDto = {
  node_id: string;
  slug: string;
  label: string;
  label_i18n_key: string | null;
  route_path: string;
  active_prefix: string | null;
  nav_end: boolean;
  show_leaf_hyphen: boolean;
  account_id: number | null;
  /** Operational account when `account_id` is a liability snapshot row. */
  portfolio_group_id: number | null;
  /** A Pasivos group's `liability_groups.id` (its colour target); absent elsewhere. */
  liability_group_id?: number;
  expense_account_id: number | null;
  expense_account_slug: string | null;
  asset_group_slug: string | null;
  api_group: string | null;
  api_subgroup: string | null;
  color_rgb: string | null;
  color: string | null;
  kind_slug: string | null;
  dashboard_bucket_slug: string | null;
  exclude_from_parent_total: boolean;
  /**
   * Group nodes: the group is declared a basket (`portfolio_groups.basket`, set from the panel's
   * group editor) — a managed set of holdings shown as one position. Absent on leaves.
   */
  basket?: boolean;
  /** `nav_bucket` = sidebar grouping only (e.g. inversiones, efectivo); `liability_group` = Pasivos root. */
  group_kind: "bucket" | "reference" | "nav_bucket" | "liability_group";
  /**
   * Inactive accounts (long zero tail) are omitted from the tree; group buckets whose children are
   * all inactive are kept but marked — the sidebar hides them, group pages keep them for period cards.
   */
  chart_inactive?: boolean;
  /**
   * Group nodes: every account id in this node's subtree as the data links it — the omitted
   * chart-inactive leaves included — so card metrics, the accounts table's coverage and the
   * value map read membership from the tree instead of guessing it from asset-group slug
   * prefixes (which the reparented leaves of a managed portfolio defeat). Absent on leaves.
   */
  member_account_ids?: number[];
  /**
   * Groups from elsewhere in the tree that belong on this node's page as sibling cards, from its
   * single-source chart reference overlays (see `listSingleSourceReferenceSlugsByChartHost`).
   * Omitted when the node hosts none.
   */
  linked_card_slugs?: string[];
  /**
   * Grouped chart structure for this node's page (sidebar-nav payload only, via
   * `annotateSidebarNavChartBuckets`): the same bucket lines the real grouped blocks carry, so
   * the client's loading skeleton renders the final chart shape. Absent ⇔ the real payload has
   * no grouped blocks for this node.
   */
  chart_buckets?: NavNodeChartBucketsDto;
  /**
   * This node's page draws the liabilities coverage chart in the composition slot (sidebar-nav
   * payload only, via `annotateSidebarNavChartBuckets`; `groupHostsLiabilitiesCoverage`), so the
   * client mounts it from first paint. Absent ⇔ the page keeps its composition chart.
   */
  chart_coverage?: true;
  children: NavTreeNodeDto[];
};
