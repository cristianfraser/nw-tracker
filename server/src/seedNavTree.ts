import { placeAllAccounts } from "./accountPlacement.js";
import { db } from "./db.js";
import { assertNavGroupItemsShape } from "./portfolioGroupTree.js";
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
  /** The dashboard card this node draws (NW buckets only). */
  dashboard?: {
    sort_order: number;
    bucket_slug: string;
    card_css?: string;
    card_label_i18n_key?: string;
  };
  /** Roles (migration 272): set when the node is created, data afterwards. */
  nw_bucket?: boolean;
  investment_root?: boolean;
  /** A deposit into the bucket is money put to work outside cash (migration 337). */
  investment_deposit_target?: boolean;
  property_overlay?: boolean;
  /** The group whose owed total this group's value nets. */
  nets_linked_slug?: string;
};

/**
 * A node is created when missing and never rewritten: once it exists its attributes are data
 * (labels, colours, routes, roles), changed by migrations or the panel, not by every boot.
 */
const insertGroup = db.prepare(`
  INSERT INTO portfolio_groups (
    parent_id, slug, label, sort_order, color_rgb, route_path, active_prefix,
    nav_end, show_leaf_hyphen, label_i18n_key, api_group, api_subgroup, asset_group_slug, sidebar_section,
    group_kind, chart_host_slug, kind_slug, exclude_from_parent_total,
    dashboard_sort_order, dashboard_card_kind, dashboard_bucket_slug, dashboard_card_css,
    dashboard_card_label_i18n_key, nw_bucket, investment_root, property_overlay, investment_deposit_target
  )
  VALUES (
    @parent_id, @slug, @label, @sort_order, @color_rgb, @route_path, @active_prefix,
    @nav_end, @show_leaf_hyphen, @label_i18n_key, @api_group, @api_subgroup, @asset_group_slug, @sidebar_section,
    @group_kind, @chart_host_slug, @kind_slug, @exclude_from_parent_total,
    @dashboard_sort_order, @dashboard_card_kind, @dashboard_bucket_slug, @dashboard_card_css,
    @dashboard_card_label_i18n_key, @nw_bucket, @investment_root, @property_overlay, @investment_deposit_target
  )
  ON CONFLICT(slug) DO NOTHING
`);

const groupIdBySlug = db.prepare(`SELECT id FROM portfolio_groups WHERE slug = ?`);


const insertGroupChild = db.prepare(`
  INSERT INTO portfolio_group_items (group_id, item_kind, child_group_id, sort_order)
  VALUES (?, 'group', ?, ?)
  ON CONFLICT(group_id, child_group_id) DO NOTHING
`);

const insertLinkedGroupChild = db.prepare(`
  INSERT INTO portfolio_group_items (group_id, item_kind, child_group_id, sort_order, link_weight)
  VALUES (?, 'linked_group', ?, ?, ?)
  ON CONFLICT(group_id, child_group_id) DO NOTHING
`);

const insertExpenseChild = db.prepare(`
  INSERT INTO portfolio_group_items (group_id, item_kind, expense_account_id, sort_order)
  VALUES (?, 'expense_account', ?, ?)
  ON CONFLICT(group_id, expense_account_id) DO UPDATE SET sort_order = excluded.sort_order
`);

function parentId(slug: string | undefined): number | null {
  if (!slug) return null;
  const row = groupIdBySlug.get(slug) as { id: number } | undefined;
  if (!row) throw new Error(`seedNavTree: parent ${slug} does not exist`);
  return row.id;
}

/** Nodes this seed created (their roles that name another node are set once all exist). */
const createdNets = new Map<string, string>();

/** Creates the node when missing; an existing node is left as it is. Returns its id. */
function upsert(g: GroupUpsert): number {
  const created = insertGroup.run({
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
    dashboard_sort_order: g.dashboard?.sort_order ?? null,
    dashboard_card_kind: g.dashboard ? "bucket" : null,
    dashboard_bucket_slug: g.dashboard?.bucket_slug ?? null,
    dashboard_card_css: g.dashboard?.card_css ?? null,
    dashboard_card_label_i18n_key: g.dashboard?.card_label_i18n_key ?? null,
    nw_bucket: g.nw_bucket ? 1 : 0,
    investment_root: g.investment_root ? 1 : 0,
    investment_deposit_target: g.investment_deposit_target ? 1 : 0,
    property_overlay: g.property_overlay ? 1 : 0,
  }).changes > 0;
  if (created && g.nets_linked_slug) createdNets.set(g.slug, g.nets_linked_slug);
  return (groupIdBySlug.get(g.slug) as { id: number }).id;
}

/** The netting roles of the nodes created this run (their targets exist by now). */
function setCreatedNettingRoles(): void {
  for (const [slug, linked] of createdNets) {
    const target = groupIdBySlug.get(linked) as { id: number } | undefined;
    if (!target) throw new Error(`seedNavTree: ${slug} nets ${linked}, which does not exist`);
    db.prepare(`UPDATE portfolio_groups SET nets_linked_group_id = ? WHERE slug = ?`).run(target.id, slug);
  }
  createdNets.clear();
}

function linkLinkedGroup(parentSlug: string, childSlug: string, sort: number, weight: number) {
  const parent = groupIdBySlug.get(parentSlug) as { id: number } | undefined;
  const child = groupIdBySlug.get(childSlug) as { id: number } | undefined;
  if (!parent || !child) {
    throw new Error(`seedNavTree: linked group ${parentSlug} -> ${childSlug}: ${!parent ? parentSlug : childSlug} does not exist`);
  }
  insertLinkedGroupChild.run(parent.id, child.id, sort, weight);
}

/** Links a child group under its parent when the edge is missing (an existing edge is data). */
function linkGroup(parentSlug: string, childSlug: string, sort: number) {
  const parent = groupIdBySlug.get(parentSlug) as { id: number } | undefined;
  const child = groupIdBySlug.get(childSlug) as { id: number } | undefined;
  if (!parent || !child) {
    throw new Error(`seedNavTree: group ${parentSlug} -> ${childSlug}: ${!parent ? parentSlug : childSlug} does not exist`);
  }
  insertGroupChild.run(parent.id, child.id, sort);
}

/**
 * A (possibly gated) sidebar page node in ONE call: the group row AND the
 * `portfolio_group_items` edge. The nav payload renders children from group ITEMS —
 * `parent_id` alone is not walked — so an upsert without the link is an invisible orphan
 * that still looks correct in `portfolio_groups`. This helper exists so that half-added
 * state cannot be expressed: gate true seeds row + edge together; gate false creates nothing
 * (a page once created stays).
 */
function seedSidebarChildPage(
  gate: boolean,
  g: GroupUpsert & { parent_slug: string; route_path: string }
): void {
  if (!gate) return;
  upsert({ active_prefix: g.route_path, ...g });
  linkGroup(g.parent_slug, g.slug, g.sort_order);
}

/** Links every tracked place (`expense_accounts`) under the real-estate expenses node. */
function linkExpenseAccounts(parentSlug: string) {
  const pid = (groupIdBySlug.get(parentSlug) as { id: number }).id;
  const rows = db
    .prepare(
      `SELECT a.id FROM expense_accounts a
       JOIN expense_groups g ON g.id = a.group_id
       ORDER BY a.sort_order, a.id`
    )
    .all() as { id: number }[];
  rows.forEach((row, i) => insertExpenseChild.run(pid, row.id, i * 10));
}

/**
 * Retirement's fixed links: the Chilean subtree (AFP + AFC; APV → APV A, APV B) under Chile when
 * the country split exists (`retirement_cl`, created by {@link ensureRetirementCountrySplit}), else
 * straight under Retirement, as it always was. The US side is linked by account placement while
 * its leaves hold accounts (`accountPlacement.ts`).
 */
function linkRetirementGroups(): void {
  const chileParent = groupIdBySlug.get("retirement_cl") != null ? "retirement_cl" : "retirement";
  if (chileParent !== "retirement") linkGroup("retirement", "retirement_cl", 0);
  linkGroup(chileParent, "retirement_afp_afc", 0);
  linkGroup(chileParent, "retirement_apv", 20);
  linkGroup("retirement_apv", "retirement_apv_a", 0);
  linkGroup("retirement_apv", "retirement_apv_b", 10);
}

/** The country split's portfolio groups (created by {@link ensureRetirementCountrySplit}). */
const RETIREMENT_COUNTRY_GROUPS: readonly (GroupUpsert & { parent_slug: string })[] = [
  {
    slug: "retirement_cl",
    label: "Chile",
    label_i18n_key: "retirement.chile",
    parent_slug: "retirement",
    sort_order: 0,
    route_path: "/inversiones/retiro/chile",
    active_prefix: "/inversiones/retiro/chile",
    api_group: "retirement",
    api_subgroup: "cl",
    asset_group_slug: "retirement_cl",
    group_kind: "bucket",
    color_rgb: "220,38,38",
  },
  {
    slug: "retirement_us",
    label: "US",
    label_i18n_key: "retirement.us",
    parent_slug: "retirement",
    sort_order: 10,
    route_path: "/inversiones/retiro/us",
    active_prefix: "/inversiones/retiro/us",
    api_group: "retirement",
    api_subgroup: "us",
    asset_group_slug: "retirement_us",
    group_kind: "bucket",
    color_rgb: "37,99,235",
  },
  {
    slug: "retirement_us_401k",
    label: "401(k)",
    label_i18n_key: "retirement.us401k",
    parent_slug: "retirement_us",
    sort_order: 0,
    route_path: "/inversiones/retiro/us/401k",
    active_prefix: "/inversiones/retiro/us/401k",
    api_group: "retirement",
    api_subgroup: "us_401k",
    asset_group_slug: "retirement_us_401k",
    kind_slug: "us_401k",
    group_kind: "bucket",
    color_rgb: "59,130,246",
  },
  {
    slug: "retirement_us_roth_ira",
    label: "Roth IRA",
    label_i18n_key: "retirement.rothIra",
    parent_slug: "retirement_us",
    sort_order: 10,
    route_path: "/inversiones/retiro/us/roth-ira",
    active_prefix: "/inversiones/retiro/us/roth-ira",
    api_group: "retirement",
    api_subgroup: "roth_ira",
    asset_group_slug: "retirement_us_roth_ira",
    kind_slug: "roth_ira",
    group_kind: "bucket",
    color_rgb: "124,58,237",
  },
  {
    slug: "retirement_us_hsa",
    label: "HSA",
    label_i18n_key: "retirement.hsa",
    parent_slug: "retirement_us",
    sort_order: 20,
    route_path: "/inversiones/retiro/us/hsa",
    active_prefix: "/inversiones/retiro/us/hsa",
    api_group: "retirement",
    api_subgroup: "hsa",
    asset_group_slug: "retirement_us_hsa",
    kind_slug: "hsa",
    group_kind: "bucket",
    color_rgb: "13,148,136",
  },
];

/**
 * Splits Retirement by country (docs/demo-us-chapter-plan.md, phase 3) — the demo generator calls
 * it; the personal instance never does, so its tree stays as it is. Creates the Chile and US
 * portfolio groups and the US leaves (their asset groups are seeded by `db.ts` on every
 * database), moves the Chilean sub-buckets under Chile — their asset groups too (leaf slugs, and so
 * every account's behaviour kind, unchanged) — with their links, and places the accounts written
 * before their buckets existed (the US ones). Idempotent. A US leaf is in the tree while it holds an
 * account (`accountPlacement.ts`): one created later is linked when its first account is placed.
 *
 * A US account goes on its leaf asset group: `retirement_us_401k__us_401k` (a 401(k): a cuota
 * ledger on its own `accounts.fund_series_key`, priced in the series' currency),
 * `retirement_us_hsa__hsa` (the same), `retirement_us_roth_ira__roth_ira` (shares, `equity_ticker`).
 */
export function ensureRetirementCountrySplit(): void {
  // The Chilean sub-buckets and Retirement itself must exist before they move.
  seedNavTree();
  db.transaction(() => {
    const assetId = db.prepare(`SELECT id FROM asset_groups WHERE slug = ?`);
    const clAsset = assetId.get("retirement_cl") as { id: number } | undefined;
    if (!clAsset) throw new Error("ensureRetirementCountrySplit: asset group retirement_cl is missing (db.ts seeds it)");
    for (const slug of ["retirement_afp_afc", "retirement_apv"]) {
      const r = db.prepare(`UPDATE asset_groups SET parent_id = ? WHERE slug = ? AND parent_id IS NOT ?`).run(clAsset.id, slug, clAsset.id);
      if (r.changes === 0 && assetId.get(slug) == null) {
        throw new Error(`ensureRetirementCountrySplit: asset group ${slug} is missing`);
      }
    }
    for (const g of RETIREMENT_COUNTRY_GROUPS) upsert(g);
    const clId = (groupIdBySlug.get("retirement_cl") as { id: number }).id;
    const retirementId = (groupIdBySlug.get("retirement") as { id: number }).id;
    for (const slug of ["retirement_afp_afc", "retirement_apv"]) {
      const r = db.prepare(`UPDATE portfolio_groups SET parent_id = ? WHERE slug = ? AND parent_id IS NOT ?`).run(clId, slug, clId);
      if (r.changes === 0 && groupIdBySlug.get(slug) == null) {
        throw new Error(`ensureRetirementCountrySplit: portfolio group ${slug} is missing (seedNavTree first)`);
      }
      // Its link moves with it (re-linked under Chile below).
      db.prepare(
        `DELETE FROM portfolio_group_items
         WHERE item_kind = 'group' AND group_id = ? AND child_group_id = (SELECT id FROM portfolio_groups WHERE slug = ?)`
      ).run(retirementId, slug);
    }
    linkRetirementGroups();
    placeAllAccounts();
    assertNavGroupItemsShape();
  })();
}

/**
 * The nav tree's reference rows: the sidebar and net-worth groups, their fixed links, the chart
 * overlays, the gated pages and the Pasivos subtree. Idempotent, and it never places an account:
 * an account's membership is written by the code that creates or moves it (`placeAccount`,
 * `accountPlacement.ts`). Boot runs it and then requires every account to be where its asset group
 * says (`assertAccountsPlaced`): a misplaced account fails the boot, the seed does not move it.
 */
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
      dashboard: {
        sort_order: 40,
        bucket_slug: "cash_eqs",
        card_css: "cash",
        card_label_i18n_key: "dashboard.buckets.cash_savings",
      },
      nw_bucket: true,
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
      nets_linked_slug: "liabilities_credit_card",
    });
    upsert({
      slug: "checking_accounts",
      label: "Checking",
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
    linkGroup("cash_eqs", "cash_savings", 10);
    linkGroup("cash_eqs", "checking_accounts", 20);

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
    upsert({
      slug: "real_estate",
      label: "Real estate",
      label_i18n_key: "dashboard.buckets.real_estate",
      sort_order: 30,
      route_path: "/real_estate",
      asset_group_slug: "real_estate",
      sidebar_section: "main",
      dashboard: { sort_order: 10, bucket_slug: "real_estate" },
      nw_bucket: true,
      investment_deposit_target: true,
      property_overlay: true,
    });

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
      dashboard: { sort_order: 30, bucket_slug: "brokerage" },
      nw_bucket: true,
      investment_deposit_target: true,
      investment_root: true,
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
      slug: "brokerage_opciones",
      label: "Opciones",
      parent_slug: "brokerage",
      sort_order: 25,
      route_path: "/inversiones/brokerage/opciones",
      active_prefix: "/inversiones/brokerage/opciones",
      api_group: "brokerage",
      api_subgroup: "opciones",
      kind_slug: "options",
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
      slug: "retirement",
      label: "Retiro",
      label_i18n_key: "dashboard.cards.retirement",
      parent_slug: "inversiones",
      sort_order: 20,
      route_path: "/inversiones/retiro",
      active_prefix: "/inversiones/retiro",
      api_group: "retirement",
      asset_group_slug: "retirement",
      dashboard: { sort_order: 20, bucket_slug: "retirement" },
      nw_bucket: true,
      investment_deposit_target: true,
      investment_root: true,
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

    linkGroup("inversiones", "brokerage", 10);
    linkGroup("inversiones", "retirement", 20);
    // Brokerage's class buckets, a managed unit and the US retirement leaves are linked by account
    // placement while they hold accounts (`accountPlacement.ts`); Retirement's Chilean subtree is fixed.
    linkRetirementGroups();

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
            `SELECT COUNT(*) AS c FROM expense_accounts`
          )
          .get() as { c: number }
      ).c > 0;
    seedSidebarChildPage(hasRealEstateExpenseAccounts, {
      slug: "flows_expenses_real_estate",
      label: "Inmuebles",
      label_i18n_key: "sidebar.flowsExpensesRealEstate",
      parent_slug: "flows_expenses",
      sort_order: 0,
      route_path: "/flows/expenses/real_estate",
    });
    // "Supermercado" (grocery receipts + product catalog) only exists once boletas have been
    // imported — same data-driven rule as the real-estate node above.
    const hasGroceryReceipts =
      (db.prepare(`SELECT COUNT(*) AS c FROM grocery_receipts`).get() as { c: number }).c > 0;
    seedSidebarChildPage(hasGroceryReceipts, {
      slug: "flows_expenses_groceries",
      label: "Supermercado",
      label_i18n_key: "sidebar.flowsExpensesGroceries",
      parent_slug: "flows_expenses",
      sort_order: 5,
      route_path: "/flows/expenses/groceries",
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
    upsert({
      slug: "flows_pl",
      label: "PL",
      label_i18n_key: "sidebar.flowsPl",
      parent_slug: "flows",
      sort_order: 30,
      route_path: "/flows/pl",
      nav_end: true,
    });

    linkGroup("flows", "flows_income", 0);
    linkGroup("flows", "flows_expenses", 10);
    linkGroup("flows", "flows_deposits", 20);
    linkGroup("flows", "flows_pl", 30);
    if (hasRealEstateExpenseAccounts) {
      linkExpenseAccounts("flows_expenses_real_estate");
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
      slug: "tax_return",
      label: "Declaración de renta",
      label_i18n_key: "sidebar.taxReturn",
      sort_order: 59,
      route_path: "/tax-return",
      active_prefix: "/tax-return",
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

    linkGroup("rates", "rates_watchlist", 10);

    linkGroup("net_worth", "real_estate", 10);
    linkGroup("net_worth", "inversiones", 20);
    linkGroup("net_worth", "cash_eqs", 30);
    linkGroup("net_worth", "liabilities", 40);
    // Chart overlays last: their sources are the buckets created above.
    seedLiabilitiesReferenceChartGroups();
    seedCashReferenceChartGroups();
    setCreatedNettingRoles();
  });
  // One transaction (the inner ones become savepoints): a shape violation rolls the whole
  // seed back instead of leaving it committed behind a failed boot.
  db.transaction(() => {
    tx();
    seedLiabilitiesTree();
    assertNavGroupItemsShape();
  })();
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
  linkLinkedGroup("liabilities_ref_disponible", "brokerage", 0, 1);
  linkLinkedGroup("liabilities_ref_disponible", "cash_eqs", 10, 1);
  linkLinkedGroup("liabilities_ref_disponible_total", "brokerage", 0, 1);
  linkLinkedGroup("liabilities_ref_disponible_total", "cash_eqs", 10, 1);
  linkLinkedGroup("liabilities_ref_disponible_total", "retirement_apv", 20, 0.85);
}
