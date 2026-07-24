import { useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { AddAccountForm } from "../../components/panel/AddAccountForm";
import { AccountExcludeFromTotalsToggle } from "../../components/panel/AccountExcludeFromTotalsToggle";
import { EditAccountModal } from "../../components/panel/EditAccountModal";
import { EntityColorPicker } from "../../components/dashboard/EntityColorPicker";
import { Table } from "../../components/ui/Table";
import { api } from "../../api";
import { queryKeys } from "../../queries/keys";
import { useAccountsAll, usePanelNetWorthTree } from "../../queries/hooks";
import { countAccountsInNavSubtree } from "../../panelAccounts/portfolioNavBuckets";
import { NavAccountsTree } from "../../components/nav/NavAccountsTree";
import type { AccountListRow, NavTreeNodeDto } from "../../types";

function PortfolioGroupTableRows({
  node,
  depth = 0,
}: {
  node: NavTreeNodeDto;
  depth?: number;
}) {
  const indent = depth * 16;
  const accountCount = countAccountsInNavSubtree(node);
  const childGroups = node.children.filter(
    (c) => c.portfolio_group_id != null && c.account_id == null
  ).length;
  return (
    <>
      <tr>
        <td className="mono">{node.portfolio_group_id}</td>
        <td style={{ paddingLeft: indent }}>
          {depth > 0 ? <span className="muted mono">└─ </span> : null}
          {node.label}
          {childGroups > 0 ? (
            <span className="muted"> ({childGroups} sub-groups)</span>
          ) : (
            <span className="muted"> ({accountCount} accounts)</span>
          )}
        </td>
        <td className="mono">{node.slug}</td>
        <td className="mono">{node.group_kind}</td>
        <td className="mono">{accountCount}</td>
        <td>
          <EntityColorPicker
            colorRgb={node.color_rgb}
            colorTarget={{ kind: "portfolio_group", slug: node.slug }}
            size="compact"
          />
        </td>
      </tr>
      {node.children
        .filter((c) => c.portfolio_group_id != null && c.account_id == null)
        .map((child) => (
          <PortfolioGroupTableRows key={child.node_id} node={child} depth={depth + 1} />
        ))}
    </>
  );
}

export function AccountsPanelPage() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [deletingId, setDeletingId] = useState<number | null>(null);
  const [editingAccount, setEditingAccount] = useState<AccountListRow | null>(null);
  const { data: accountsData, error: accountsError, isPending: accountsPending } = useAccountsAll();
  const {
    data: panelTreeData,
    error: panelTreeError,
    isPending: panelTreePending,
  } = usePanelNetWorthTree();

  const err =
    accountsError instanceof Error
      ? accountsError.message
      : panelTreeError instanceof Error
        ? panelTreeError.message
        : accountsError || panelTreeError
          ? t("common.loadFailed")
          : null;

  const netWorthNode = useMemo(() => panelTreeData?.net_worth ?? null, [panelTreeData]);
  if (accountsPending || panelTreePending) {
    return <p className="muted">{t("common.loading")}</p>;
  }

  if (err) {
    return <p className="error">{err}</p>;
  }

  const accounts = accountsData?.accounts ?? [];

  async function onDeleteAccount(id: number, name: string) {
    const ok = window.confirm(t("panelAccounts.deleteConfirm", { id, name }));
    if (!ok) return;
    setDeletingId(id);
    try {
      await api.deleteAccount(id);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.accountsAll() }),
        queryClient.invalidateQueries({ queryKey: queryKeys.panelNetWorthTree() }),
        queryClient.invalidateQueries({ queryKey: queryKeys.sidebarNav() }),
        queryClient.invalidateQueries({ queryKey: queryKeys.dashboard("clp") }),
        queryClient.invalidateQueries({ queryKey: queryKeys.dashboard("usd") }),
      ]);
    } finally {
      setDeletingId(null);
    }
  }

  return (
    <>
      <p className="muted" style={{ marginBottom: "1rem" }}>
        {t("panelAccounts.pageHint")}
      </p>
      <p className="muted" style={{ marginBottom: "1rem" }}>
        {t("panelAccounts.excludeHint")}
      </p>

      <h2 className="flow-section-title">{t("panelAccounts.addAccountTitle")}</h2>
      <AddAccountForm netWorthRoot={netWorthNode} />

      <h2 className="flow-section-title" style={{ marginTop: "2rem" }}>
        {t("panelAccounts.accountsTitle")}
      </h2>
      <Table
        header={
          <thead>
            <tr>
              <th>ID</th>
              <th>{t("panelAccounts.colAccount")}</th>
              <th>{t("panelAccounts.colBucket")}</th>
              <th>{t("panelAccounts.colExclude")}</th>
              <th>{t("panelAccounts.colActions")}</th>
            </tr>
          </thead>
        }
      >
        {accounts.length === 0 ? (
          <tr>
            <td colSpan={5} className="muted">
              {t("panelAccounts.emptyAccounts")}
            </td>
          </tr>
        ) : (
          accounts.map((a) => (
            <tr key={a.id}>
              <td className="mono">{a.id}</td>
              <td>{a.name}</td>
              <td>{a.bucket_label}</td>
              <td>
                <AccountExcludeFromTotalsToggle
                  accountId={a.id}
                  excluded={a.exclude_from_group_totals === 1}
                />
              </td>
              <td>
                <span
                  style={{ display: "inline-flex", alignItems: "center", gap: "0.5rem" }}
                >
                  <EntityColorPicker
                    colorRgb={a.color_rgb}
                    colorTarget={{ kind: "account", accountId: a.id }}
                    size="compact"
                  />
                  <button type="button" onClick={() => setEditingAccount(a)}>
                    {t("panelAccounts.editBtn")}
                  </button>
                  <button
                    type="button"
                    onClick={() => void onDeleteAccount(a.id, a.name)}
                    disabled={deletingId === a.id}
                  >
                    {deletingId === a.id ? t("common.loading") : t("panelAccounts.deleteBtn")}
                  </button>
                </span>
              </td>
            </tr>
          ))
        )}
      </Table>

      <h2 className="flow-section-title" style={{ marginTop: "2rem" }}>
        {t("panelAccounts.portfolioGroupsTitle")}
      </h2>
      <Table
        header={
          <thead>
            <tr>
              <th>ID</th>
              <th>{t("panelAccounts.colBucket")}</th>
              <th>{t("panelAccounts.colSlug")}</th>
              <th>{t("panelAccounts.colGroupKind")}</th>
              <th>{t("panelAccounts.colAccounts")}</th>
              <th>{t("panelAccounts.colActions")}</th>
            </tr>
          </thead>
        }
      >
        {!netWorthNode ? (
          <tr>
            <td colSpan={6} className="muted">
              {t("panelAccounts.emptyTree")}
            </td>
          </tr>
        ) : (
          <PortfolioGroupTableRows node={netWorthNode} />
        )}
      </Table>

      <h2 className="flow-section-title" style={{ marginTop: "2rem" }}>
        {t("panelAccounts.netWorthTreeTitle")}
      </h2>
      {netWorthNode ? (
        <NavAccountsTree root={netWorthNode} />
      ) : (
        <p className="muted">{t("panelAccounts.emptyTree")}</p>
      )}

      {editingAccount ? (
        <EditAccountModal
          key={editingAccount.id}
          account={editingAccount}
          netWorthRoot={netWorthNode}
          onClose={() => setEditingAccount(null)}
        />
      ) : null}
    </>
  );
}
