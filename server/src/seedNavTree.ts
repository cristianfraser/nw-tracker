import { db } from "./db.js";
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
  group_kind?: "normal" | "reference";
  chart_host_slug?: string | null;
};

const upsertGroup = db.prepare(`
  INSERT INTO portfolio_groups (
    parent_id, slug, label, sort_order, color_rgb, route_path, active_prefix,
    nav_end, show_leaf_hyphen, label_i18n_key, api_group, api_subgroup, asset_group_slug, sidebar_section,
    group_kind, chart_host_slug
  )
  VALUES (
    @parent_id, @slug, @label, @sort_order, @color_rgb, @route_path, @active_prefix,
    @nav_end, @show_leaf_hyphen, @label_i18n_key, @api_group, @api_subgroup, @asset_group_slug, @sidebar_section,
    @group_kind, @chart_host_slug
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
    chart_host_slug = excluded.chart_host_slug
`);

const groupIdBySlug = db.prepare(`SELECT id FROM portfolio_groups WHERE slug = ?`);

const deleteGroupItems = db.prepare(`DELETE FROM portfolio_group_items WHERE group_id = ?`);

const deleteRetiredPortfolioGroups = db.prepare(`
  DELETE FROM portfolio_groups WHERE slug IN ('retirement_afp', 'retirement_afc')
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
    group_kind: g.group_kind ?? "normal",
    chart_host_slug: g.chart_host_slug ?? null,
  });
  return (groupIdBySlug.get(g.slug) as { id: number }).id;
}

function linkLinkedGroup(parentSlug: string, childSlug: string, sort: number, weight: number) {
  const pid = (groupIdBySlug.get(parentSlug) as { id: number }).id;
  const cid = (groupIdBySlug.get(childSlug) as { id: number }).id;
  insertLinkedGroupChild.run(pid, cid, sort, weight);
}

function linkGroup(parentSlug: string, childSlug: string, sort: number) {
  const pid = (groupIdBySlug.get(parentSlug) as { id: number }).id;
  const cid = (groupIdBySlug.get(childSlug) as { id: number }).id;
  insertGroupChild.run(pid, cid, sort);
}

function linkAccountsByAssetGroup(parentSlug: string, assetGroupSlug: string, sortStart = 0) {
  const pid = (groupIdBySlug.get(parentSlug) as { id: number }).id;
  const rows = db
    .prepare(
      `SELECT a.id, c.sort_order AS cso
       FROM accounts a
       JOIN categories c ON c.id = a.category_id
       JOIN asset_groups g ON g.id = c.group_id
       WHERE g.slug = ?
         AND (a.notes IS NULL OR a.notes != 'import:excel|key=stocks')
       ORDER BY c.sort_order, c.id, a.name`
    )
    .all(assetGroupSlug) as { id: number; cso: number }[];
  rows.forEach((r, i) => insertAccountChild.run(pid, r.id, sortStart + i * 10));
}

function linkAccountsByNotes(parentSlug: string, notes: string[], sortStart = 0) {
  const pid = (groupIdBySlug.get(parentSlug) as { id: number }).id;
  notes.forEach((n, i) => {
    const row = db.prepare(`SELECT id FROM accounts WHERE notes = ?`).get(n) as { id: number } | undefined;
    if (row) insertAccountChild.run(pid, row.id, sortStart + i * 10);
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
  linkAccountsByNotes("retirement_afp_afc", ["import:excel|key=afp"], 0);
  linkAccountsByNotes("retirement_afp_afc", ["import:excel|key=afc"], 10);

  linkGroup("retirement", "retirement_apv", 20);
  linkGroup("retirement_apv", "retirement_apv_a", 0);
  linkGroup("retirement_apv", "retirement_apv_b", 10);
  linkAccountsByNotes("retirement_apv_a", [
    "import:excel|key=apv_a_principal",
    "import:excel|key=apv_a",
  ]);
  linkAccountsByNotes("retirement_apv_b", ["import:excel|key=apv_b"]);

  deleteRetiredPortfolioGroups.run();
}

function rebuildBrokerageNav() {
  const brkId = (groupIdBySlug.get("brokerage") as { id: number }).id;
  deleteGroupItems.run(brkId);
  linkGroup("brokerage", "brokerage_mutual_funds", 0);
  linkGroup("brokerage", "brokerage_acciones", 10);
  linkGroup("brokerage", "brokerage_crypto", 20);
  linkAccountsByNotes("brokerage_mutual_funds", ["import:excel|key=fintual_rn"]);
  linkAccountsByNotes("brokerage_acciones", ["import:excel|key=spy", "import:excel|key=vea"]);
  linkAccountsByNotes("brokerage_crypto", ["import:excel|key=bitcoin", "import:excel|key=eth"]);
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
      asset_group_slug: "cash_eqs",
      sidebar_section: "main",
    });
    const cashId = (groupIdBySlug.get("cash_eqs") as { id: number }).id;
    deleteGroupItems.run(cashId);
    linkAccountsByAssetGroup("cash_eqs", "cash_eqs");
    linkLinkedGroup("cash_eqs", "liabilities_credit_card", 100, 1);

    upsert({
      slug: "liabilities",
      label: "Liabilities",
      label_i18n_key: "dashboard.cards.liabilities",
      sort_order: 20,
      route_path: "/liabilities",
      asset_group_slug: "liabilities",
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
      color_rgb: "234,179,8",
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
    upsert({
      slug: "flows_expenses_real_estate",
      label: "Inmuebles",
      label_i18n_key: "sidebar.flowsExpensesRealEstate",
      parent_slug: "flows_expenses",
      sort_order: 0,
      route_path: "/flows/expenses/real_estate",
      active_prefix: "/flows/expenses/real_estate",
    });
    upsert({
      slug: "flows_deposits",
      label: "Depósitos",
      label_i18n_key: "sidebar.flowsDeposits",
      parent_slug: "flows",
      sort_order: 20,
      route_path: "/flows/deposits",
      nav_end: true,
    });

    const flowsId = (groupIdBySlug.get("flows") as { id: number }).id;
    deleteGroupItems.run(flowsId);
    linkGroup("flows", "flows_income", 0);
    linkGroup("flows", "flows_expenses", 10);
    linkGroup("flows", "flows_deposits", 20);
    linkGroup("flows_expenses", "flows_expenses_real_estate", 0);
    linkExpenseAccounts("flows_expenses_real_estate", ["el_vergel", "lastarria", "suecia"]);

    upsert({
      slug: "rates",
      label: "Tipos de cambio",
      label_i18n_key: "sidebar.rates",
      sort_order: 60,
      route_path: "/rates",
      nav_end: true,
      show_leaf_hyphen: false,
      sidebar_section: "link",
    });

    rebuildNetWorthDashboardLinks();
    applyDashboardBucketLayout();
  });
  tx();
  seedLiabilitiesTree();
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
    linkGroup("net_worth", "retirement", 20);
    linkGroup("net_worth", "brokerage", 30);
    linkGroup("net_worth", "cash_eqs", 40);
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
        dashboard_card_css = 'cash'
      WHERE slug = 'cash_eqs';
      UPDATE portfolio_groups
      SET dashboard_card_label_i18n_key = 'dashboard.cards.inversiones'
      WHERE slug = 'brokerage';
    `);
  } catch (e) {
    console.warn("applyDashboardBucketLayout skipped (run migrations):", e instanceof Error ? e.message : e);
  }
}
