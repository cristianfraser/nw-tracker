import { useMemo, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { brokeragePortfolioGroupFromCategorySlug } from "../../brokerageGroupedAggregation";
import { useTranslation } from "../../i18n";
import {
  assetAccountSidebarLabel,
  brokerageAccountNavLabel,
  hideRedundantGroupRow,
  liabilityCategoryNavLabel,
  retirementAccountNavLabel,
} from "../../navAccountLabels";
import { navHierarchyTableChildrenForDisplay } from "../../portfolioNavFromApi";
import { resolveNavTreeLabel } from "../../sidebarNavFromApi";
import type { AccountListRow, NavTreeNodeDto } from "../../types";
import { HierarchyNavRow } from "../dashboard/HierarchyNavRow";
import { Table } from "../ui/Table";

type HierarchyLabelContext = {
  assetGroupSlug: string | null;
  apiGroup: string | null;
};

function accountsByIdMap(accounts: readonly AccountListRow[]): Map<number, AccountListRow> {
  const m = new Map<number, AccountListRow>();
  for (const a of accounts) {
    m.set(a.id, a);
    if (a.source_account_id != null && a.source_account_id > 0) {
      m.set(a.source_account_id, a);
    }
  }
  return m;
}

function accountForNavNode(
  node: NavTreeNodeDto,
  accountsById: Map<number, AccountListRow>
): AccountListRow | undefined {
  if (node.account_id != null && node.account_id > 0) {
    return accountsById.get(node.account_id);
  }
  if (node.source_account_id != null && node.source_account_id > 0) {
    return accountsById.get(node.source_account_id);
  }
  return undefined;
}

function leafAccountsInSubtree(
  node: NavTreeNodeDto,
  accountsById: Map<number, AccountListRow>
): AccountListRow[] {
  const out: AccountListRow[] = [];
  const visit = (n: NavTreeNodeDto) => {
    if (n.account_id != null && n.account_id > 0) {
      const a = accountForNavNode(n, accountsById);
      if (a) out.push(a);
      return;
    }
    for (const c of n.children ?? []) visit(c);
  };
  visit(node);
  return out;
}

function hierarchyLabelContext(root: NavTreeNodeDto): HierarchyLabelContext {
  return {
    assetGroupSlug: root.asset_group_slug,
    apiGroup: root.api_group,
  };
}

function accountDisplayLabel(a: AccountListRow, ctx: HierarchyLabelContext): string {
  const group = a.group_slug ?? ctx.apiGroup ?? "";
  if (group === "inversiones" || ctx.apiGroup === "inversiones") {
    if (brokeragePortfolioGroupFromCategorySlug(a.category_slug)) {
      return brokerageAccountNavLabel(a);
    }
    if (a.category_slug === "afp" || a.category_slug === "afc" || a.category_slug === "apv") {
      return retirementAccountNavLabel(a);
    }
  }
  if (group === "real_estate" || ctx.assetGroupSlug === "real_estate") {
    return assetAccountSidebarLabel(a);
  }
  if (group === "liabilities" || ctx.apiGroup === "liabilities") {
    return a.name;
  }
  return a.name;
}

function GroupColumnMuted({ node, ctx }: { node: NavTreeNodeDto; ctx: HierarchyLabelContext }) {
  const { t } = useTranslation();
  const slug = node.slug;
  const ag = node.asset_group_slug ?? ctx.assetGroupSlug ?? ctx.apiGroup ?? "";
  if (ag === "brokerage" || node.api_group === "brokerage") {
    return <span className="muted">Brokerage</span>;
  }
  if (ag === "retirement" || node.api_group === "retirement") {
    return <span className="muted">{t("dashboard.cards.retirement")}</span>;
  }
  if (ag === "credit_cards" || slug === "santander") {
    return <span className="muted">{t("liabilities.creditCard")}</span>;
  }
  if (ag === "liabilities" || slug.startsWith("liabilities")) {
    return <span className="muted">{t("dashboard.cards.liabilities")}</span>;
  }
  if (ag === "cash_eqs") {
    return <span className="muted">{t("dashboard.cards.cash")}</span>;
  }
  if (ag === "real_estate") {
    return <span className="muted">{t("dashboard.cards.realEstate")}</span>;
  }
  if (slug === "net_worth") {
    return <span className="muted">{t("dashboard.cards.netWorth")}</span>;
  }
  return <span className="muted">—</span>;
}

function accountRow(
  a: AccountListRow,
  depth: number,
  ctx: HierarchyLabelContext,
  key: string | number
): ReactNode {
  const category =
    ctx.apiGroup === "liabilities"
      ? liabilityCategoryNavLabel(a.category_slug)
      : a.category_label;
  return (
    <HierarchyNavRow
      key={key}
      depth={depth}
      isGroup={false}
      nameCell={<Link to={`/account/${a.id}`}>{accountDisplayLabel(a, ctx)}</Link>}
      categoryCell={category}
      groupCell={<span className="muted">{a.group_label}</span>}
      notesCell={<span className="muted">{a.notes ?? "—"}</span>}
    />
  );
}

function isNavGroupNode(node: NavTreeNodeDto): boolean {
  return (node.portfolio_group_id != null && node.portfolio_group_id > 0) || (node.children?.length ?? 0) > 0;
}

function renderNavHierarchySubtree(
  node: NavTreeNodeDto,
  depth: number,
  accountsById: Map<number, AccountListRow>,
  ctx: HierarchyLabelContext
): ReactNode[] {
  if (node.account_id != null && node.account_id > 0 && !(node.children?.length ?? 0)) {
    if (node.chart_inactive) return [];
    const a = accountForNavNode(node, accountsById);
    return a ? [accountRow(a, depth, ctx, node.node_id)] : [];
  }

  if (!isNavGroupNode(node)) return [];

  const label = resolveNavTreeLabel(node);
  const leaves = leafAccountsInSubtree(node, accountsById);
  const collapse =
    leaves.length > 0 &&
    hideRedundantGroupRow(label, leaves, (a) => accountDisplayLabel(a, ctx));

  if (collapse) {
    return leaves.map((a) => accountRow(a, depth, ctx, a.id));
  }

  const rows: ReactNode[] = [];
  const showGroupRow =
    Boolean(node.route_path?.trim()) &&
    node.account_id == null &&
    ((node.children?.length ?? 0) > 0 || (node.portfolio_group_id != null && node.portfolio_group_id > 0));

  if (showGroupRow) {
    rows.push(
      <HierarchyNavRow
        key={node.node_id}
        depth={depth}
        isGroup
        nameCell={
          node.route_path ? (
            <Link to={node.route_path}>{label}</Link>
          ) : (
            label
          )
        }
        categoryCell={<span className="muted">—</span>}
        groupCell={<GroupColumnMuted node={node} ctx={ctx} />}
        notesCell={<span className="muted">—</span>}
      />
    );
  }

  const childDepth = showGroupRow ? depth + 1 : depth;
  for (const child of node.children ?? []) {
    rows.push(...renderNavHierarchySubtree(child, childDepth, accountsById, ctx));
  }
  return rows;
}

export function GroupInfoNavHierarchyTable({
  rootNode,
  accounts,
  titleI18nKey = "groupPage.accountsTreeTitle",
  emptyI18nKey = "groupPage.accountsTreeEmpty",
}: {
  rootNode: NavTreeNodeDto;
  accounts: readonly AccountListRow[];
  /** Section heading (e.g. `dashboard.accountsTreeTitle` on home). */
  titleI18nKey?: string;
  emptyI18nKey?: string;
}) {
  const { t } = useTranslation();
  const accountsById = useMemo(() => accountsByIdMap(accounts), [accounts]);
  const ctx = useMemo(() => hierarchyLabelContext(rootNode), [rootNode]);
  const tableChildren = useMemo(() => navHierarchyTableChildrenForDisplay(rootNode), [rootNode]);

  const rootLabel = resolveNavTreeLabel(rootNode);
  const subtreeRows = tableChildren.flatMap((child) =>
    renderNavHierarchySubtree(child, 1, accountsById, ctx)
  );
  const hasRows = subtreeRows.length > 0;

  return (
    <>
      <h2 style={{ marginTop: "2rem" }}>{t(titleI18nKey)}</h2>
      <Table
        tableClassName="hierarchy-nav-table"
        header={
          <thead>
            <tr>
              <th>{t("groupPage.accountsTreeName")}</th>
              <th>{t("groupPage.accountsTreeCategory")}</th>
              <th>{t("groupPage.accountsTreeGroup")}</th>
              <th>{t("groupPage.accountsTreeNotes")}</th>
            </tr>
          </thead>
        }
      >
        <HierarchyNavRow
          depth={0}
          isGroup
          nameCell={
            rootNode.route_path ? (
              <Link to={rootNode.route_path}>{rootLabel}</Link>
            ) : (
              rootLabel
            )
          }
          categoryCell={<span className="muted">—</span>}
          groupCell={<GroupColumnMuted node={rootNode} ctx={ctx} />}
          notesCell={<span className="muted">—</span>}
        />
        {hasRows ? (
          subtreeRows
        ) : (
          <tr>
            <td colSpan={4} className="muted" style={{ paddingLeft: "calc(var(--space-sm) + var(--space-lg))" }}>
              {t(emptyI18nKey)}
            </td>
          </tr>
        )}
      </Table>
    </>
  );
}
