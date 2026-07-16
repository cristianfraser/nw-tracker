import { db } from "./db.js";
import { leafAssetGroupIdsUnder } from "./assetGroupTree.js";
import { clearAggregationCache } from "./aggregationCache.js";
import { seedCreditCardTree } from "./seedCreditCardTree.js";
import { seedLiabilitiesTree } from "./seedLiabilitiesTree.js";

type GroupUpsert = {
  slug: string;
  label: string;
  label_i18n_key?: string;
  sort_order: number;
  route_path?: string;
  active_prefix?: string;
  nav_end?: boolean;
  show_leaf_hyphen?: boolean;
  api_group?: string;
  api_subgroup?: string;
  asset_group_slug?: string;
  sidebar_section?: "main" | "flows" | "link" | "nested";
  parent_slug?: string;
  color_rgb?: string;
  group_kind?: "bucket" | "reference" | "nav_bucket" | "liability_group";
  kind_slug?: string;
  exclude_from_parent_total?: boolean;
  chart_host_slug?: string | null;
};

const upsertGroup = db.prepare(`
  INSERT INTO portfolio_groups (
    parent_id, slug, label, sort_order, color_rgb, route_path, active_prefix,
    nav_end, show_leaf_hyphen, label_i18n_key, api_group, api_subgroup, asset_group_slug, sidebar_section,
    group_kind, chart_host_slug, kind_slug, exclude_from_parent_total
  )
  VALUES (
    @parent_id, @slug, @label, @sort_order, @color_rgb, @route_path, @active_prefix,
    @nav_end, @show_leaf_hyphen, @label_i18n_key, @api_group, @api_subgroup, @asset_group_slug, @sidebar_section,
    @group_kind, @chart_host_slug, @kind_slug, @exclude_from_parent_total
  )
  ON CONFLICT(slug) DO UPDATE SET
    parent_id = excluded.parent_id,
    label = excluded.label,
    sort_order = excluded.sort_order,
    route_path = COALESCE(excluded.route_path, portfolio_groups.route_path),
    active_prefix = COALESCE(excluded.active_prefix, portfolio_groups.active_prefix),
    nav_end = excluded.nav_end,
    show_leaf_hyphen = excluded.show_leaf_hyphen,
    label_i18n_key = COALESCE(excluded.label_i18n_key, portfolio_groups.label_i18n_key),
    api_group = COALESCE(excluded.api_group, portfolio_groups.api_group),
    api_subgroup = COALESCE(excluded.api_subgroup, portfolio_groups.api_subgroup),
    asset_group_slug = COALESCE(excluded.asset_group_slug, portfolio_groups.asset_group_slug),
    sidebar_section = excluded.sidebar_section,
    color_rgb = COALESCE(excluded.color_rgb, portfolio_groups.color_rgb),
    group_kind = excluded.group_kind,
    chart_host_slug = excluded.chart_host_slug,
    kind_slug = COALESCE(excluded.kind_slug, portfolio_groups.kind_slug),
    exclude_from_parent_total = excluded.exclude_from_parent_total
`);

const groupIdBySlug = db.prepare(`SELECT id FROM portfolio_groups WHERE slug = ?`);

/** Apartments tracked on Flujos > Gastos > Inmuebles (rows in `expense_accounts`). */
const REAL_ESTATE_EXPENSE_ACCOUNT_SLUGS = ["el_vergel", "lastarria", "suecia"] as const;

const deleteGroupItems = db.prepare(`DELETE FROM portfolio_group_items WHERE group_id = ?`);

const deleteRetiredPortfolioGroups = db.prepare(`
  DELETE FROM portfolio_groups
  WHERE slug IN ('retirement_afp', 'retirement_afc', 'retirement_afp_afc__afp', 'retirement_afp_afc__afc')
`);

const insertGroupChild = db.prepare(`
  INSERT INTO portfolio_group_items (group_id, item_kind, child_group_id, sort_order)
  VALUES (?, 'group', ?, ?)
  ON CONFLICT(group_id, child_group_id) DO UPDATE SET sort_order = excluded.sort_order
`);

const insertLinkedGroupChild = db.prepare(`
  INSERT INTO portfolio_group_items (group_id, item_kind, child_group_id, sort_order, link_weight)
  VALUES (?, 'linked_group', ?, ?, ?)
  ON CONFLICT(group_id, child_group_id) DO UPDATE SET
    item_kind = 'linked_group',
    sort_order = excluded.sort_order,
    link_weight = excluded.link_weight
`);

const insertAccountChild = db.prepare(`
  INSERT INTO portfolio_group_items (group_id, item_kind, account_id, sort_order)
  VALUES (?, 'account', ?, ?)
  ON CONFLICT(group_id, account_id) DO UPDATE SET sort_order = excluded.sort_order
`);

const insertExpenseChild = db.prepare(`
  INSERT INTO portfolio_group_items (group_id, item_kind, expense_account_id, sort_order)
  VALUES (?, 'expense_account', ?, ?)
  ON CONFLICT(group_id, expense_account_id) DO UPDATE SET sort_order = excluded.sort_order
`);

function parentId(slug: string | undefined): number | null {
  if (!slug) return null;
  const row = groupIdBySlug.get(slug) as { id: number } | undefined;
  return row?.id ?? null;
}

function upsert(g: GroupUpsert): number {
  upsertGroup.run({
    parent_id: parentId(g.parent_slug),
    slug: g.slug,
    label: g.label,
    sort_order: g.sort_order,
    color_rgb: g.color_rgb ?? null,
    route_path: g.route_path ?? null,
    active_prefix: g.active_prefix ?? null,
    nav_end: g.nav_end ? 1 : 0,
    show_leaf_hyphen: g.show_leaf_hyphen === false ? 0 : 1,
    label_i18n_key: g.label_i18n_key ?? null,
    api_group: g.api_group ?? null,
    api_subgroup: g.api_subgroup ?? null,
    asset_group_slug: g.asset_group_slug ?? null,
    sidebar_section: g.sidebar_section ?? "nested",
    group_kind: g.group_kind ?? "bucket",
    chart_host_slug: g.chart_host_slug ?? null,
    kind_slug: g.kind_slug ?? null,
    exclude_from_parent_total: g.exclude_from_parent_total ? 1 : 0,
  });
  return (groupIdBySlug.get(g.slug) as { id: number }).id;
}

function linkLinkedGroup(parentSlug: string, childSlug: string, sort: number, weight: number) {
  const parent = groupIdBySlug.get(parentSlug) as { id: number } | undefined;
  const child = groupIdBySlug.get(childSlug) as { id: number } | undefined;
  if (!parent || !child) {
    // Empty/bootstrap DB: reference chart groups point at asset groups that only exist
    // once accounts are seeded. Re-running `nav:reseed` after an import creates the link.
    console.warn(
      `seedNavTree: skipping linked group ${parentSlug} -> ${childSlug} (missing ${!parent ? parentSlug : childSlug})`
    );
    return;
  }
  insertLinkedGroupChild.run(parent.id, child.id, sort, weight);
}

function linkGroup(parentSlug: string, childSlug: string, sort: number) {
  const pid = (groupIdBySlug.get(parentSlug) as { id: number }).id;
  const cid = (groupIdBySlug.get(childSlug) as { id: number }).id;
  insertGroupChild.run(pid, cid, sort);
}

/** Link accounts on leaf asset groups under `bucketSlug` (handles reparented sub-buckets). */
function linkAccountsByAssetGroup(parentSlug: string, bucketSlug: string, sortStart = 0) {
  const pid = (groupIdBySlug.get(parentSlug) as { id: number }).id;
  const leafIds = leafAssetGroupIdsUnder(bucketSlug);
  if (leafIds.length === 0) return;
  const ph = leafIds.map(() => "?").join(",");
  const rows = db
    .prepare(
      `SELECT a.id
       FROM accounts a
       WHERE a.asset_group_id IN (${ph})
         AND a.account_kind != 'liability_view'
         AND (a.notes IS NULL OR a.notes != 'import:excel|key=stocks')
       ORDER BY a.name COLLATE NOCASE`
    )
    .all(...leafIds) as { id: number }[];
  rows.forEach((r, i) => {
    insertAccountChild.run(pid, r.id, sortStart + i * 10);
    db.prepare(`UPDATE accounts SET primary_portfolio_group_id = ? WHERE id = ?`).run(pid, r.id);
  });
}

function linkExpenseAccounts(parentSlug: string, slugs: string[]) {
  const pid = (groupIdBySlug.get(parentSlug) as { id: number }).id;
  slugs.forEach((slug, i) => {
    const row = db
      .prepare(
        `SELECT a.id FROM expense_accounts a
         JOIN expense_groups g ON g.id = a.group_id
         WHERE a.slug = ?`
      )
      .get(slug) as { id: number } | undefined;
    if (row) insertExpenseChild.run(pid, row.id, i * 10);
  });
}

function rebuildRetirementNav() {
  const retId = (groupIdBySlug.get("retirement") as { id: number }).id;
  deleteGroupItems.run(retId);

  const groups = [
    "retirement_afp_afc",
    "retirement_apv",
    "retirement_apv_a",
    "retirement_apv_b",
  ] as const;
  for (const slug of groups) {
    const gid = (groupIdBySlug.get(slug) as { id: number } | undefined)?.id;
    if (gid != null) deleteGroupItems.run(gid);
  }

  linkGroup("retirement", "retirement_afp_afc", 0);
  linkAccountsByAssetGroup("retirement_afp_afc", "retirement_afp_afc", 0);

  linkGroup("retirement", "retirement_apv", 20);
  linkGroup("retirement_apv", "retirement_apv_a", 0);
  linkGroup("retirement_apv", "retirement_apv_b", 10);
  linkAccountsByAssetGroup("retirement_apv_a", "retirement_apv_a", 0);
  linkAccountsByAssetGroup("retirement_apv_b", "retirement_apv_b", 0);

  deleteRetiredPortfolioGroups.run();
}

/** Any non-view account in the asset-group subtree (empty buckets stay out of the nav). */
function assetGroupSubtreeHasAccounts(bucketSlug: string): boolean {
  const leafIds = leafAssetGroupIdsUnder(bucketSlug);
  if (leafIds.length === 0) return false;
  const ph = leafIds.map(() => "?").join(",");
  const row = db
    .prepare(
      `SELECT COUNT(*) AS c FROM accounts
       WHERE asset_group_id IN (${ph}) AND account_kind != 'liability_view'`
    )
    .get(...leafIds) as { c: number };
  return row.c > 0;
}

function rebuildBrokerageNav() {
  const brkId = (groupIdBySlug.get("brokerage") as { id: number }).id;
  deleteGroupItems.run(brkId);
  // Data-driven: a sub-bucket links only when it holds accounts — the real DB has no
  // long_term asset group, generated DBs have no mutual funds; neither should render an
  // empty bucket.
  const buckets: ReadonlyArray<[slug: string, sort: number]> = [
    ["brokerage_mutual_funds", 0],
    ["brokerage_long_term", 5],
    ["brokerage_acciones", 10],
    ["brokerage_crypto", 20],
    ["brokerage_cash", 30],
  ];
  for (const [slug, sort] of buckets) {
    if (!assetGroupSubtreeHasAccounts(slug)) continue;
    linkGroup("brokerage", slug, sort);
    linkAccountsByAssetGroup(slug, slug, 0);
  }
}

/** Idempotent full sidebar + inversiones nav tree (matches legacy layout). */
export function seedNavTree(): void {
  const tx = db.transaction(() => {
    upsert({
      slug: "dashboard",
      label: "Dashboard",
      label_i18n_key: "dashboard.cards.netWorth",
      sort_order: 0,
      route_path: "/",
      nav_end: true,
      show_leaf_hyphen: false,
      sidebar_section: "link",
    });

    upsert({
      slug: "net_worth",
      label: "Net worth",
      label_i18n_key: "dashboard.cards.netWorth",
      sort_order: -10,
      asset_group_slug: "net_worth",
      sidebar_section: "nested",
      nav_end: true,
      show_leaf_hyphen: false,
    });

    upsert({
      slug: "cash_eqs",
      label: "Cash & equivalents",
      label_i18n_key: "dashboard.buckets.cash_eqs",
      sort_order: 10,
      route_path: "/cash_eqs",
      active_prefix: "/cash_eqs",
      group_kind: "nav_bucket",
      sidebar_section: "main",
    });
    upsert({
      slug: "cash_savings",
      label: "Cash savings",
      label_i18n_key: "dashboard.buckets.cash_savings",
      parent_slug: "cash_eqs",
      sort_order: 10,
      route_path: "/cash_eqs/savings",
      active_prefix: "/cash_eqs/savings",
      asset_group_slug: "cash_eqs__cash_savings",
      kind_slug: "cash_savings",
      group_kind: "bucket",
      sidebar_section: "main",
    });
    upsert({
      slug: "checking_accounts",
      label: "Checking accounts",
      label_i18n_key: "sidebar.checking_accounts",
      parent_slug: "cash_eqs",
      sort_order: 20,
      route_path: "/cash_eqs/checking",
      active_prefix: "/cash_eqs/checking",
      asset_group_slug: "cash_eqs__checking_accounts",
      kind_slug: "checking_accounts",
      group_kind: "bucket",
      sidebar_section: "main",
    });
    const cashId = (groupIdBySlug.get("cash_eqs") as { id: number }).id;
    deleteGroupItems.run(cashId);
    linkGroup("cash_eqs", "cash_savings", 10);
    linkGroup("cash_eqs", "checking_accounts", 20);
    const savingsNavId = (groupIdBySlug.get("cash_savings") as { id: number }).id;
    deleteGroupItems.run(savingsNavId);
    linkAccountsByAssetGroup("cash_savings", "cash_eqs__cash_savings");
    const checkingNavId = (groupIdBySlug.get("checking_accounts") as { id: number }).id;
    deleteGroupItems.run(checkingNavId);
    linkAccountsByAssetGroup("checking_accounts", "cash_eqs__checking_accounts");

    db.prepare(`UPDATE portfolio_groups SET asset_group_slug = NULL WHERE slug = 'cash_eqs'`).run();

    upsert({
      slug: "liabilities",
      label: "Liabilities",
      label_i18n_key: "dashboard.cards.liabilities",
      sort_order: 20,
      route_path: "/liabilities",
      asset_group_slug: "liabilities",
      group_kind: "liability_group",
      sidebar_section: "main",
    });
    upsert({
      slug: "liabilities_credit_card",
      label: "Tarjeta de crédito",
      parent_slug: "liabilities",
      sort_order: 0,
      route_path: "/liabilities/credit-card",
      active_prefix: "/liabilities/credit-card",
      label_i18n_key: "liabilities.creditCard",
    });
    upsert({
      slug: "liabilities_mortgage",
      label: "Hipoteca",
      parent_slug: "liabilities",
      sort_order: 10,
      route_path: "/liabilities/mortgage",
      active_prefix: "/liabilities/mortgage",
      label_i18n_key: "liabilities.mortgage",
    });
    const liabId = (groupIdBySlug.get("liabilities") as { id: number }).id;
    deleteGroupItems.run(liabId);

    // The operational Tarjetas de crédito top-level page was removed (2026-07): cards are
    // managed from their account pages under Pasivos. Drop the legacy sidebar row.
    const legacyCreditCards = db
      .prepare(`SELECT id FROM portfolio_groups WHERE slug = 'credit_cards' AND sidebar_section = 'main'`)
      .get() as { id: number } | undefined;
    if (legacyCreditCards) {
      deleteGroupItems.run(legacyCreditCards.id);
      db.prepare(`DELETE FROM portfolio_groups WHERE id = ?`).run(legacyCreditCards.id);
    }

    seedLiabilitiesReferenceChartGroups();
    seedCashReferenceChartGroups();

    upsert({
      slug: "real_estate",
      label: "Real estate",
      label_i18n_key: "dashboard.buckets.real_estate",
      sort_order: 30,
      route_path: "/real_estate",
      asset_group_slug: "real_estate",
      sidebar_section: "main",
    });
    const reId = (groupIdBySlug.get("real_estate") as { id: number }).id;
    deleteGroupItems.run(reId);
    linkAccountsByAssetGroup("real_estate", "real_estate");

    upsert({
      slug: "inversiones",
      label: "Inversiones",
      label_i18n_key: "sidebar.inversiones",
      sort_order: 40,
      route_path: "/inversiones",
      active_prefix: "/inversiones",
      api_group: "inversiones",
      group_kind: "nav_bucket",
      sidebar_section: "main",
    });

    upsert({
      slug: "brokerage",
      label: "Brokerage",
      label_i18n_key: "dashboard.cards.brokerage",
      parent_slug: "inversiones",
      sort_order: 10,
      route_path: "/inversiones/brokerage",
      active_prefix: "/inversiones/brokerage",
      api_group: "brokerage",
      asset_group_slug: "brokerage",
    });
    upsert({
      slug: "brokerage_mutual_funds",
      label: "Mutual funds",
      parent_slug: "brokerage",
      sort_order: 10,
      route_path: "/inversiones/brokerage/mutual-funds",
      active_prefix: "/inversiones/brokerage/mutual-funds",
      api_group: "brokerage",
      api_subgroup: "mutual_funds",
      kind_slug: "mutual_funds",
      group_kind: "bucket",
    });
    upsert({
      slug: "brokerage_long_term",
      label: "Long-term",
      parent_slug: "brokerage",
      sort_order: 15,
      route_path: "/inversiones/brokerage/long-term",
      active_prefix: "/inversiones/brokerage/long-term",
      api_group: "brokerage",
      api_subgroup: "long_term",
      kind_slug: "long_term",
      group_kind: "bucket",
    });
    upsert({
      slug: "brokerage_acciones",
      label: "Acciones",
      parent_slug: "brokerage",
      sort_order: 20,
      route_path: "/inversiones/brokerage/acciones",
      active_prefix: "/inversiones/brokerage/acciones",
      api_group: "brokerage",
      api_subgroup: "acciones",
      kind_slug: "acciones",
      group_kind: "bucket",
    });
    upsert({
      slug: "brokerage_crypto",
      label: "Crypto",
      parent_slug: "brokerage",
      sort_order: 30,
      route_path: "/inversiones/brokerage/crypto",
      active_prefix: "/inversiones/brokerage/crypto",
      api_group: "brokerage",
      api_subgroup: "crypto",
      kind_slug: "crypto",
      group_kind: "bucket",
      color_rgb: "234,179,8",
    });
    upsert({
      slug: "brokerage_cash",
      label: "Cash",
      parent_slug: "brokerage",
      sort_order: 40,
      route_path: "/inversiones/brokerage/cash",
      active_prefix: "/inversiones/brokerage/cash",
      api_group: "brokerage",
      api_subgroup: "cash",
      kind_slug: "brokerage_cash",
      group_kind: "bucket",
    });

    upsert({
      slug: "retirement",
      label: "Retiro",
      label_i18n_key: "dashboard.cards.retirement",
      parent_slug: "inversiones",
      sort_order: 20,
      route_path: "/inversiones/retiro",
      active_prefix: "/inversiones/retiro",
      api_group: "retirement",
      asset_group_slug: "retirement",
    });
    upsert({
      slug: "retirement_afp_afc",
      label: "AFP + AFC",
      label_i18n_key: "retirement.afpAfc",
      parent_slug: "retirement",
      sort_order: 0,
      route_path: "/inversiones/retiro/afp-afc",
      active_prefix: "/inversiones/retiro/afp-afc",
      api_group: "retirement",
      api_subgroup: "afp_afc",
      kind_slug: "afp_afc",
      group_kind: "bucket",
    });
    upsert({
      slug: "retirement_apv",
      label: "APV",
      label_i18n_key: "retirement.apv",
      parent_slug: "retirement",
      sort_order: 20,
      route_path: "/inversiones/retiro/apv",
      active_prefix: "/inversiones/retiro/apv",
      api_group: "retirement",
      api_subgroup: "apv",
      kind_slug: "apv",
      group_kind: "bucket",
    });
    upsert({
      slug: "retirement_apv_a",
      label: "apv-a",
      parent_slug: "retirement_apv",
      sort_order: 0,
      route_path: "/inversiones/retiro/apv/apv-a",
      active_prefix: "/inversiones/retiro/apv/apv-a",
      api_group: "retirement",
      api_subgroup: "apv_a",
      kind_slug: "apv_a",
      group_kind: "bucket",
    });
    upsert({
      slug: "retirement_apv_b",
      label: "apv-b",
      parent_slug: "retirement_apv",
      sort_order: 10,
      route_path: "/inversiones/retiro/apv/apv-b",
      active_prefix: "/inversiones/retiro/apv/apv-b",
      api_group: "retirement",
      api_subgroup: "apv_b",
      kind_slug: "apv_b",
      group_kind: "bucket",
    });

    const invId = (groupIdBySlug.get("inversiones") as { id: number }).id;
    deleteGroupItems.run(invId);
    linkGroup("inversiones", "brokerage", 10);
    linkGroup("inversiones", "retirement", 20);
    rebuildBrokerageNav();
    rebuildRetirementNav();

    upsert({
      slug: "flows",
      label: "Flujos",
      label_i18n_key: "sidebar.flows",
      sort_order: 50,
      route_path: "/flows",
      active_prefix: "/flows",
      sidebar_section: "flows",
    });
    upsert({
      slug: "flows_income",
      label: "Ingresos",
      label_i18n_key: "sidebar.flowsIncome",
      parent_slug: "flows",
      sort_order: 0,
      route_path: "/flows/income",
      nav_end: true,
    });
    upsert({
      slug: "flows_expenses",
      label: "Gastos",
      label_i18n_key: "sidebar.flowsExpenses",
      parent_slug: "flows",
      sort_order: 10,
      route_path: "/flows/expenses",
      active_prefix: "/flows/expenses",
    });
    // "Inmuebles" (per-apartment expected-bills tracking) only exists when its expense
    // accounts do — generated/demo DBs have no expense_accounts rows, and an always-on
    // node would just route to a permanently empty page there.
    const hasRealEstateExpenseAccounts =
      (
        db
          .prepare(
            `SELECT COUNT(*) AS c FROM expense_accounts a
             WHERE a.slug IN (${REAL_ESTATE_EXPENSE_ACCOUNT_SLUGS.map(() => "?").join(",")})`
          )
          .get(...REAL_ESTATE_EXPENSE_ACCOUNT_SLUGS) as { c: number }
      ).c > 0;
    if (hasRealEstateExpenseAccounts) {
      upsert({
        slug: "flows_expenses_real_estate",
        label: "Inmuebles",
        label_i18n_key: "sidebar.flowsExpensesRealEstate",
        parent_slug: "flows_expenses",
        sort_order: 0,
        route_path: "/flows/expenses/real_estate",
        active_prefix: "/flows/expenses/real_estate",
      });
    } else {
      // Items cascade on group delete (parent link + expense children).
      const stale = groupIdBySlug.get("flows_expenses_real_estate") as { id: number } | undefined;
      if (stale) db.prepare(`DELETE FROM portfolio_groups WHERE id = ?`).run(stale.id);
    }
    upsert({
      slug: "flows_deposits",
      label: "Depósitos",
      label_i18n_key: "sidebar.flowsDeposits",
      parent_slug: "flows",
      sort_order: 20,
      route_path: "/flows/deposits",
      nav_end: true,
    });
    upsert({
      slug: "flows_pl",
      label: "PL",
      label_i18n_key: "sidebar.flowsPl",
      parent_slug: "flows",
      sort_order: 30,
      route_path: "/flows/pl",
      nav_end: true,
    });

    const flowsId = (groupIdBySlug.get("flows") as { id: number }).id;
    deleteGroupItems.run(flowsId);
    linkGroup("flows", "flows_income", 0);
    linkGroup("flows", "flows_expenses", 10);
    linkGroup("flows", "flows_deposits", 20);
    linkGroup("flows", "flows_pl", 30);
    if (hasRealEstateExpenseAccounts) {
      linkGroup("flows_expenses", "flows_expenses_real_estate", 0);
      linkExpenseAccounts("flows_expenses_real_estate", [...REAL_ESTATE_EXPENSE_ACCOUNT_SLUGS]);
    }

    // The global /search page was folded into the flows tables (dashboard = master view);
    // drop its legacy sidebar link row.
    const legacySearch = db
      .prepare(`SELECT id FROM portfolio_groups WHERE slug = 'search' AND sidebar_section = 'link'`)
      .get() as { id: number } | undefined;
    if (legacySearch) {
      deleteGroupItems.run(legacySearch.id);
      db.prepare(`DELETE FROM portfolio_groups WHERE id = ?`).run(legacySearch.id);
    }

    upsert({
      slug: "projections",
      label: "Proyecciones",
      label_i18n_key: "sidebar.projections",
      sort_order: 57,
      route_path: "/projections",
      active_prefix: "/projections",
      nav_end: false,
      show_leaf_hyphen: false,
      sidebar_section: "link",
    });

    upsert({
      slug: "wealth_percentile",
      label: "Percentil de riqueza",
      label_i18n_key: "sidebar.wealthPercentile",
      sort_order: 58,
      route_path: "/wealth-percentile",
      active_prefix: "/wealth-percentile",
      nav_end: false,
      show_leaf_hyphen: false,
      sidebar_section: "link",
    });

    upsert({
      slug: "rates",
      label: "Tipos de cambio",
      label_i18n_key: "sidebar.rates",
      sort_order: 60,
      route_path: "/rates",
      active_prefix: "/rates",
      nav_end: false,
      show_leaf_hyphen: false,
      sidebar_section: "link",
    });

    upsert({
      slug: "rates_watchlist",
      label: "Watchlist",
      label_i18n_key: "sidebar.watchlist",
      parent_slug: "rates",
      sort_order: 10,
      route_path: "/watchlist",
      nav_end: true,
      show_leaf_hyphen: false,
      sidebar_section: "link",
    });

    const ratesId = (groupIdBySlug.get("rates") as { id: number }).id;
    deleteGroupItems.run(ratesId);
    linkGroup("rates", "rates_watchlist", 10);

    rebuildNetWorthDashboardLinks();
    applyDashboardBucketLayout();
  });
  tx();
  seedCreditCardTree();
  seedLiabilitiesTree();
  clearAggregationCache();
  console.log("nav tree: seeded sidebar portfolio_groups + liability_groups");
}

/** Efectivo chart overlay: linked Pasivos > tarjeta de crédito total (not a sidebar leaf). */
function seedCashReferenceChartGroups() {
  upsert({
    slug: "cash_eqs_ref_credit_card",
    label: "Tarjeta de crédito",
    label_i18n_key: "liabilities.creditCard",
    sort_order: 10,
    group_kind: "reference",
    chart_host_slug: "cash_eqs",
    sidebar_section: "nested",
    nav_end: true,
  });
  const refId = (groupIdBySlug.get("cash_eqs_ref_credit_card") as { id: number }).id;
  deleteGroupItems.run(refId);
  linkLinkedGroup("cash_eqs_ref_credit_card", "liabilities_credit_card", 0, 1);
}

/** Pasivos root chart overlays (not sidebar leaves). */
function seedLiabilitiesReferenceChartGroups() {
  upsert({
    slug: "liabilities_ref_disponible",
    label: "Disponible",
    label_i18n_key: "liabilities.ref.disponible",
    sort_order: 100,
    group_kind: "reference",
    chart_host_slug: "liabilities",
    color_rgb: "94,234,212",
    sidebar_section: "nested",
    nav_end: true,
  });
  upsert({
    slug: "liabilities_ref_disponible_total",
    label: "Disponible total",
    label_i18n_key: "liabilities.ref.disponibleTotal",
    sort_order: 110,
    group_kind: "reference",
    chart_host_slug: "liabilities",
    color_rgb: "45,212,191",
    sidebar_section: "nested",
    nav_end: true,
  });
  const dispId = (groupIdBySlug.get("liabilities_ref_disponible") as { id: number }).id;
  const dispTotId = (groupIdBySlug.get("liabilities_ref_disponible_total") as { id: number }).id;
  deleteGroupItems.run(dispId);
  deleteGroupItems.run(dispTotId);
  linkLinkedGroup("liabilities_ref_disponible", "brokerage", 0, 1);
  linkLinkedGroup("liabilities_ref_disponible", "cash_eqs", 10, 1);
  linkLinkedGroup("liabilities_ref_disponible_total", "brokerage", 0, 1);
  linkLinkedGroup("liabilities_ref_disponible_total", "cash_eqs", 10, 1);
  linkLinkedGroup("liabilities_ref_disponible_total", "retirement_apv", 20, 0.85);
}

/** First-level dashboard buckets under logical `net_worth` root (see migration 036). */
function rebuildNetWorthDashboardLinks() {
  try {
    const nw = groupIdBySlug.get("net_worth") as { id: number } | undefined;
    if (!nw) return;
    deleteGroupItems.run(nw.id);
    linkGroup("net_worth", "real_estate", 10);
    linkGroup("net_worth", "inversiones", 20);
    linkGroup("net_worth", "cash_eqs", 30);
    linkGroup("net_worth", "liabilities", 40);
  } catch (e) {
    console.warn("rebuildNetWorthDashboardLinks:", e instanceof Error ? e.message : e);
  }
}

/** Keep dashboard card order / bucket mapping in sync with migration `035_dashboard_layout_portfolio_groups.sql`. */
function applyDashboardBucketLayout() {
  try {
    db.exec(`
      UPDATE portfolio_groups SET
        dashboard_sort_order = 10,
        dashboard_card_kind = 'bucket',
        dashboard_bucket_slug = 'real_estate',
        dashboard_card_css = NULL
      WHERE slug = 'real_estate';
      UPDATE portfolio_groups SET
        dashboard_sort_order = 20,
        dashboard_card_kind = 'bucket',
        dashboard_bucket_slug = 'retirement',
        dashboard_card_css = NULL
      WHERE slug = 'retirement';
      UPDATE portfolio_groups SET
        dashboard_sort_order = 30,
        dashboard_card_kind = 'bucket',
        dashboard_bucket_slug = 'brokerage',
        dashboard_card_css = NULL
      WHERE slug = 'brokerage';
      UPDATE portfolio_groups SET
        dashboard_sort_order = 40,
        dashboard_card_kind = 'bucket',
        dashboard_bucket_slug = 'cash_eqs',
        dashboard_card_css = 'cash',
        dashboard_card_label_i18n_key = COALESCE(dashboard_card_label_i18n_key, 'dashboard.buckets.cash_savings')
      WHERE slug = 'cash_eqs';
      UPDATE portfolio_groups SET
        dashboard_sort_order = NULL,
        dashboard_card_kind = NULL,
        dashboard_bucket_slug = NULL,
        dashboard_card_css = NULL,
        dashboard_card_label_i18n_key = NULL
      WHERE slug = 'cash_savings';
      UPDATE portfolio_groups
      SET dashboard_card_label_i18n_key = 'dashboard.cards.inversiones'
      WHERE slug = 'brokerage';
    `);
  } catch (e) {
    console.warn("applyDashboardBucketLayout skipped (run migrations):", e instanceof Error ? e.message : e);
  }
}
