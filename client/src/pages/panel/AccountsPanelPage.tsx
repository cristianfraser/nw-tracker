import { useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { PageGridTile } from "../../components/layout/PageGridTile";
import { AddAccountForm } from "../../components/panel/AddAccountForm";
import { AccountExcludeFromTotalsToggle } from "../../components/panel/AccountExcludeFromTotalsToggle";
import { EditAccountModal } from "../../components/panel/EditAccountModal";
import { EntityColorPicker } from "../../components/dashboard/EntityColorPicker";
import { Loadable, loadableClass } from "../../components/ui/Loadable";
import { cn } from "../../cn";
import styles from "./AccountsPanelPage.module.css";
import { api } from "../../api";
import { queryKeys } from "../../queries/keys";
import { useAccountsAll, usePanelNetWorthTree } from "../../queries/hooks";
import { countAccountsInNavSubtree } from "../../panelAccounts/portfolioNavBuckets";
import { NavAccountsTree } from "../../components/nav/NavAccountsTree";
import type { AccountListRow, NavTreeNodeDto } from "../../types";
import { Button } from "@crfrsr/ui";

function PortfolioGroupTableRows({
  node,
  depth = 0,
}: {
  node: NavTreeNodeDto;
  depth?: number;
}) {
  const accountCount = countAccountsInNavSubtree(node);
  const childGroups = node.children.filter(
    (c) => c.portfolio_group_id != null && c.account_id == null
  ).length;
  return (
    <>
      <div role="listitem" className={cn(styles.row, styles.groupRow)}>
        <span className={cn("mono", styles.id)}>{node.portfolio_group_id}</span>
        <span className={styles.label}>
          {Array.from({ length: depth }, (_, i) => (
            <span key={i} className={styles.indent} aria-hidden />
          ))}
          {depth > 0 ? <span className="muted mono">└─ </span> : null}
          {node.label}
          {childGroups > 0 ? (
            <span className="muted"> ({childGroups} sub-groups)</span>
          ) : (
            <span className="muted"> ({accountCount} accounts)</span>
          )}
        </span>
        <span className={cn("mono", styles.slug)}>{node.slug}</span>
        <span className={cn("mono", styles.kind)}>{node.group_kind}</span>
        <span className={cn("mono", styles.count)}>{accountCount}</span>
        <span className={styles.actions}>
          <EntityColorPicker
            colorRgb={node.color_rgb}
            colorTarget={{ kind: "portfolio_group", slug: node.slug }}
            size="compact"
          />
        </span>
      </div>
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
      <PageGridTile id="add-account">
        <h2 className="flow-section-title">{t("panelAccounts.addAccountTitle")}</h2>
        <Loadable loading={panelTreePending}>
          <AddAccountForm netWorthRoot={netWorthNode} />
        </Loadable>
      </PageGridTile>

      <PageGridTile id="accounts">
        <h2 className="flow-section-title">
          {t("panelAccounts.accountsTitle")}
        </h2>
        <div className={cn(styles.list, loadableClass(accountsPending))}>
          <div className={cn(styles.row, styles.accountRow, styles.header)}>
            <span className={styles.id}>ID</span>
            <span className={styles.name}>{t("panelAccounts.colAccount")}</span>
            <span className={styles.bucket}>{t("panelAccounts.colBucket")}</span>
            <span className={styles.exclude}>{t("panelAccounts.colExclude")}</span>
            <span className={styles.actions}>{t("panelAccounts.colActions")}</span>
          </div>
          {accounts.length === 0 ? (
            accountsPending ? null : (
              <p className="muted">{t("panelAccounts.emptyAccounts")}</p>
            )
          ) : (
            <div role="list">
              {accounts.map((a) => (
                <div key={a.id} role="listitem" className={cn(styles.row, styles.accountRow)}>
                  <span className={cn("mono", styles.id)}>{a.id}</span>
                  <span className={styles.name}>{a.name}</span>
                  <span className={styles.bucket}>{a.bucket_label}</span>
                  <span className={styles.exclude}>
                    <AccountExcludeFromTotalsToggle
                      accountId={a.id}
                      excluded={a.exclude_from_group_totals === 1}
                    />
                  </span>
                  <span className={styles.actions}>
                    <EntityColorPicker
                      colorRgb={a.color_rgb}
                      colorTarget={{ kind: "account", accountId: a.id }}
                      size="compact"
                    />
                    <Button variant="secondary" onClick={() => setEditingAccount(a)}>
                      {t("panelAccounts.editBtn")}
                    </Button>
                    <Button variant="secondary"
                      onClick={() => void onDeleteAccount(a.id, a.name)}
                      disabled={deletingId === a.id}
                    >
                      {deletingId === a.id ? t("common.loading") : t("panelAccounts.deleteBtn")}
                    </Button>
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      </PageGridTile>

      <PageGridTile id="portfolio-groups">
        <h2 className="flow-section-title">
          {t("panelAccounts.portfolioGroupsTitle")}
        </h2>
        <div className={cn(styles.list, loadableClass(panelTreePending))}>
          <div className={cn(styles.row, styles.groupRow, styles.header)}>
            <span className={styles.id}>ID</span>
            <span className={styles.label}>{t("panelAccounts.colBucket")}</span>
            <span className={styles.slug}>{t("panelAccounts.colSlug")}</span>
            <span className={styles.kind}>{t("panelAccounts.colGroupKind")}</span>
            <span className={styles.count}>{t("panelAccounts.colAccounts")}</span>
            <span className={styles.actions}>{t("panelAccounts.colActions")}</span>
          </div>
          {!netWorthNode ? (
            panelTreePending ? null : <p className="muted">{t("panelAccounts.emptyTree")}</p>
          ) : (
            <div role="list">
              <PortfolioGroupTableRows node={netWorthNode} />
            </div>
          )}
        </div>
      </PageGridTile>

      <PageGridTile id="net-worth-tree">
        <h2 className="flow-section-title">
          {t("panelAccounts.netWorthTreeTitle")}
        </h2>
        {netWorthNode ? (
          <NavAccountsTree root={netWorthNode} />
        ) : panelTreePending ? null : (
          <p className="muted">{t("panelAccounts.emptyTree")}</p>
        )}
      </PageGridTile>

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
