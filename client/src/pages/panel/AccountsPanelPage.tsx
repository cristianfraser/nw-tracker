import { useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { AddStockAccountForm } from "../../components/panel/AddStockAccountForm";
import { Table } from "../../components/ui/Table";
import { api } from "../../api";
import { queryKeys } from "../../queries/keys";
import { useAccountsAll, useAssetTree, useSidebarNav } from "../../queries/hooks";
import { countAccountsInBucketTree } from "../../panelAccounts/assetTreeBuckets";
import { NavAccountsTree } from "../../components/nav/NavAccountsTree";
import type { AssetTreeGroupRow } from "../../types";

function BucketTreeRows({
  node,
  depth = 0,
}: {
  node: AssetTreeGroupRow;
  depth?: number;
}) {
  const indent = depth * 16;
  const accountCount = countAccountsInBucketTree(node);
  const childCount = node.children?.length ?? 0;
  return (
    <>
      <tr>
        <td className="mono">{node.id}</td>
        <td style={{ paddingLeft: indent }}>
          {depth > 0 ? <span className="muted mono">└─ </span> : null}
          {node.label}
          {node.is_leaf ? (
            <span className="muted"> ({accountCount} accounts)</span>
          ) : (
            <span className="muted"> ({childCount} sub-buckets)</span>
          )}
        </td>
        <td className="mono">{node.slug}</td>
        <td className="mono">{node.is_leaf ? accountCount : "—"}</td>
      </tr>
      {(node.children ?? []).map((child) => (
        <BucketTreeRows key={child.id} node={child} depth={depth + 1} />
      ))}
    </>
  );
}

export function AccountsPanelPage() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [deletingId, setDeletingId] = useState<number | null>(null);
  const { data: accountsData, error: accountsError, isPending: accountsPending } = useAccountsAll();
  const { data: assetTreeData, error: assetTreeError, isPending: assetTreePending } = useAssetTree();
  const { data: sidebarNavData, error: sidebarNavError, isPending: sidebarNavPending } = useSidebarNav();

  const err =
    accountsError instanceof Error
      ? accountsError.message
      : assetTreeError instanceof Error
        ? assetTreeError.message
        : sidebarNavError instanceof Error
          ? sidebarNavError.message
          : accountsError || assetTreeError || sidebarNavError
            ? t("common.loadFailed")
            : null;

  const netWorthNode = useMemo(() => sidebarNavData?.net_worth ?? null, [sidebarNavData]);

  if (accountsPending || assetTreePending || sidebarNavPending) {
    return <p className="muted">{t("common.loading")}</p>;
  }

  if (err) {
    return <p className="error">{err}</p>;
  }

  const accounts = accountsData?.accounts ?? [];
  const buckets = assetTreeData?.groups ?? [];

  async function onDeleteAccount(id: number, name: string) {
    const ok = window.confirm(t("panelAccounts.deleteConfirm", { id, name }));
    if (!ok) return;
    setDeletingId(id);
    try {
      await api.deleteAccount(id);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.accountsAll() }),
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

      <h2 className="flow-section-title">{t("panelAccounts.addAccountTitle")}</h2>
      <AddStockAccountForm assetGroups={buckets} />

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
              <td className="mono">{a.exclude_from_group_totals === 1 ? "1" : "0"}</td>
              <td>
                <button
                  type="button"
                  onClick={() => void onDeleteAccount(a.id, a.name)}
                  disabled={deletingId === a.id}
                >
                  {deletingId === a.id ? t("common.loading") : t("panelAccounts.deleteBtn")}
                </button>
              </td>
            </tr>
          ))
        )}
      </Table>

      <h2 className="flow-section-title" style={{ marginTop: "2rem" }}>
        {t("panelAccounts.bucketsTitle")}
      </h2>
      <Table
        header={
          <thead>
            <tr>
              <th>ID</th>
              <th>{t("panelAccounts.colBucket")}</th>
              <th>{t("panelAccounts.colSlug")}</th>
              <th>{t("panelAccounts.colAccounts")}</th>
            </tr>
          </thead>
        }
      >
        {buckets.length === 0 ? (
          <tr>
            <td colSpan={4} className="muted">
              {t("panelAccounts.emptyBuckets")}
            </td>
          </tr>
        ) : (
          buckets.map((g) => <BucketTreeRows key={g.id} node={g} />)
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
    </>
  );
}

