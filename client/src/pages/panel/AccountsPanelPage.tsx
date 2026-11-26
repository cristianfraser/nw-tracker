import { useQueryClient } from "@tanstack/react-query";
import { useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { PageGridTile } from "../../components/layout/PageGridTile";
import { AddAccountForm } from "../../components/panel/AddAccountForm";
import { AccountExcludeFromTotalsToggle } from "../../components/panel/AccountExcludeFromTotalsToggle";
import { GroupBasketToggle } from "../../components/panel/GroupBasketToggle";
import { EditAccountModal } from "../../components/panel/EditAccountModal";
import { EntityColorPicker } from "../../components/dashboard/EntityColorPicker";
import { Loadable } from "../../components/ui/Loadable";
import styles from "./AccountsPanelPage.module.css";
import { api } from "../../api";
import { invalidateResources, resources } from "../../queries/resources";
import { useAccountsAll, usePanelNetWorthTree } from "../../queries/hooks";
import { navAccountIdSet } from "../../portfolioNavDashboardCards";
import {
  AccountsTreeLooseAccounts,
  NavAccountsTree,
  type AccountsTreeAccount,
  type NavAccountsTreeRowExtras,
} from "../../components/nav/NavAccountsTree";
import type { AccountListRow, NavTreeNodeDto } from "../../types";
import { Button } from "@crfrsr/ui";
import { queryLoadError } from "../../queries/pageShapeReady";

/** A group with a colour of its own to set: a portfolio group, or a Pasivos group. */
function isPanelGroupRow(n: NavTreeNodeDto): boolean {
  return n.account_id == null && (n.portfolio_group_id != null || n.liability_group_id != null);
}

/** Id of the panel that an account's ⋯ opens (the button's `aria-controls`). */
function accountActionsId(rowKey: string): string {
  return `panel-account-actions-${rowKey}`;
}

export function AccountsPanelPage() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [deletingId, setDeletingId] = useState<number | null>(null);
  const [editingAccount, setEditingAccount] = useState<AccountListRow | null>(null);
  /** The row (`rowKey`) whose actions are open under it (one at a time). */
  const [openActionsKey, setOpenActionsKey] = useState<string | null>(null);
  const { data: accountsData, error: accountsError, isPending: accountsPending } = useAccountsAll();
  const {
    data: panelTreeData,
    error: panelTreeError,
    isPending: panelTreePending,
  } = usePanelNetWorthTree();

  // A failed background refetch keeps the data on screen (`queryLoadError`).
  const accountsLoadError = queryLoadError({ data: accountsData, error: accountsError });
  const panelTreeLoadError = queryLoadError({ data: panelTreeData, error: panelTreeError });
  const err =
    accountsLoadError instanceof Error
      ? accountsLoadError.message
      : panelTreeLoadError instanceof Error
        ? panelTreeLoadError.message
        : accountsLoadError || panelTreeLoadError
          ? t("common.loadFailed")
          : null;

  const netWorthNode = useMemo(() => panelTreeData?.net_worth ?? null, [panelTreeData]);
  const accountsById = useMemo(
    () => new Map((accountsData?.accounts ?? []).map((a) => [a.id, a])),
    [accountsData]
  );
  /** Accounts the tree does not hold: listed under it, so every account keeps its actions. */
  const looseAccounts = useMemo((): Omit<AccountsTreeAccount, "rowKey">[] => {
    if (!accountsData || panelTreeData === undefined) return [];
    const inTree = netWorthNode ? navAccountIdSet(netWorthNode) : new Set<number>();
    return accountsData.accounts
      .filter((a) => !inTree.has(a.id))
      .map((a) => ({ id: a.id, name: a.name, colorRgb: a.color_rgb ?? null }));
  }, [accountsData, panelTreeData, netWorthNode]);

  const treeRef = useRef<HTMLDivElement>(null);
  const treeHeadingRef = useRef<HTMLHeadingElement>(null);

  if (err) {
    return <p className="error">{err}</p>;
  }

  /** The ⋯ buttons on screen (a closed group's are not), in the order drawn. */
  function visibleActionButtons(): HTMLButtonElement[] {
    const buttons = treeRef.current?.querySelectorAll<HTMLButtonElement>("button[data-account-id]");
    return [...(buttons ?? [])].filter((b) => b.offsetParent !== null);
  }

  async function onDeleteAccount(id: number, name: string, rowKey: string) {
    const ok = window.confirm(t("panelAccounts.deleteConfirm", { id, name }));
    if (!ok) return;
    // Where the keyboard goes once the row is gone: the next account's ⋯, else the one before.
    const buttons = visibleActionButtons();
    const at = buttons.findIndex((b) => b.getAttribute("aria-controls") === accountActionsId(rowKey));
    const others = (list: HTMLButtonElement[]) => list.find((b) => b.dataset.accountId !== String(id));
    const neighbour = others(buttons.slice(at + 1)) ?? others(buttons.slice(0, Math.max(at, 0)).reverse());
    const neighbourControls = neighbour?.getAttribute("aria-controls") ?? null;
    setDeletingId(id);
    try {
      await api.deleteAccount(id);
      await invalidateResources(queryClient, resources.panelAccounts());
    } finally {
      setDeletingId(null);
    }
    requestAnimationFrame(() => {
      // Only when the deleted row took the focus with it; a viewer who moved on keeps theirs.
      const active = document.activeElement;
      if (active != null && active !== document.body && active.isConnected) return;
      const next = visibleActionButtons().find((b) => b.getAttribute("aria-controls") === neighbourControls);
      (next ?? treeHeadingRef.current)?.focus();
    });
  }

  const rowExtras: NavAccountsTreeRowExtras = {
    groupSwatch: (node) =>
      isPanelGroupRow(node) ? (
        <EntityColorPicker
          colorRgb={node.color_rgb}
          colorTarget={
            node.liability_group_id != null
              ? { kind: "liability_group", slug: node.slug }
              : { kind: "portfolio_group", slug: node.slug }
          }
          size="compact"
        />
      ) : null,
    groupMeta: (node) => {
      const id = node.portfolio_group_id ?? node.liability_group_id;
      return [node.slug, node.group_kind, id != null ? `#${id}` : null].filter(Boolean).join(" · ");
    },
    groupEnd: (node) =>
      node.account_id == null && node.portfolio_group_id != null ? (
        <span className={styles.basket}>
          <GroupBasketToggle slug={node.slug} basket={node.basket === true} />
        </span>
      ) : null,
    accountSwatch: (account) => (
      <EntityColorPicker
        colorRgb={account.colorRgb}
        colorTarget={{ kind: "account", accountId: account.id }}
        size="compact"
      />
    ),
    accountTag: (account) =>
      accountsById.get(account.id)?.exclude_from_group_totals === 1 ? (
        <span className={styles.tag} title={t("panelAccounts.outOfTotalsTag")}>
          {t("panelAccounts.outOfTotalsTag")}
        </span>
      ) : null,
    accountEnd: (account) => {
      const row = accountsById.get(account.id);
      if (!row) return null;
      const open = openActionsKey === account.rowKey;
      return (
        <button
          type="button"
          className={styles.more}
          data-account-id={account.id}
          aria-expanded={open}
          aria-controls={accountActionsId(account.rowKey)}
          aria-label={t("panelAccounts.rowActions", { name: row.name })}
          onClick={() => setOpenActionsKey(open ? null : account.rowKey)}
        >
          ⋯
        </button>
      );
    },
    accountBelow: (account) => {
      const row = accountsById.get(account.id);
      if (!row) return null;
      return (
        <div
          id={accountActionsId(account.rowKey)}
          className={styles.actions}
          hidden={openActionsKey !== account.rowKey}
        >
          <AccountExcludeFromTotalsToggle
            accountId={row.id}
            excluded={row.exclude_from_group_totals === 1}
          />
          <Button variant="secondary" onClick={() => setEditingAccount(row)}>
            {t("panelAccounts.editBtn")}
          </Button>
          <Button
            variant="secondary"
            onClick={() => void onDeleteAccount(row.id, row.name, account.rowKey)}
            disabled={deletingId === row.id}
          >
            {deletingId === row.id ? t("common.loading") : t("panelAccounts.deleteBtn")}
          </Button>
        </div>
      );
    },
  };
  const loose = { title: t("panelAccounts.notInTree"), accounts: looseAccounts };

  return (
    <>
      <PageGridTile id="add-account">
        <h2 className="flow-section-title">{t("panelAccounts.addAccountTitle")}</h2>
        <Loadable loading={panelTreePending}>
          <AddAccountForm netWorthRoot={netWorthNode} />
        </Loadable>
      </PageGridTile>

      <PageGridTile id="accounts">
        <h2 ref={treeHeadingRef} tabIndex={-1} className="flow-section-title">
          {t("panelAccounts.accountsTileTitle")}
        </h2>
        <Loadable loading={panelTreePending || accountsPending}>
          <div ref={treeRef}>
            {netWorthNode ? (
              <NavAccountsTree root={netWorthNode} rowExtras={rowExtras} looseAccounts={loose} />
            ) : panelTreePending ? (
              // The tree has not answered yet: the accounts the page already has, as plain rows.
              <AccountsTreeLooseAccounts
                accounts={(accountsData?.accounts ?? []).map((a) => ({
                  id: a.id,
                  name: a.name,
                  colorRgb: a.color_rgb ?? null,
                }))}
                standalone
              />
            ) : (
              <>
                <p className="muted">{t("panelAccounts.emptyTree")}</p>
                <AccountsTreeLooseAccounts {...loose} rowExtras={rowExtras} standalone />
              </>
            )}
          </div>
        </Loadable>
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
