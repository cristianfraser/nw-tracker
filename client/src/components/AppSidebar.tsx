import { useCallback, useEffect, useMemo, useState, type CSSProperties, type MouseEvent } from "react";
import { useTranslation } from "react-i18next";
import { NavLink, useLocation } from "react-router-dom";
import { api } from "../api";
import {
  buildSidebarNavTree,
  collectAncestorIdsToExpand,
  sidebarNodeMatchesPath,
  type SidebarNavNode,
} from "../sidebarNavTree";
import type { AccountListRow } from "../types";
import styles from "./AppSidebar.module.css";

const COLLAPSE_STORAGE_KEY = "nw-sidebar-collapsed";

function readCollapsedIds(): Set<string> {
  try {
    const raw = localStorage.getItem(COLLAPSE_STORAGE_KEY);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((x): x is string => typeof x === "string"));
  } catch {
    return new Set();
  }
}

function writeCollapsedIds(ids: Set<string>) {
  localStorage.setItem(COLLAPSE_STORAGE_KEY, JSON.stringify([...ids]));
}

function CaretIcon({ expanded }: { expanded: boolean }) {
  return (
    <svg
      className={`${styles.caretIcon}${expanded ? ` ${styles.caretIconExpanded}` : ""}`}
      width="14"
      height="14"
      viewBox="0 0 14 14"
      aria-hidden
    >
      <path
        d="M5 3.5 9 7l-4 3.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function SidebarNavItem({
  node,
  depth,
  collapsed,
  onToggleCollapse,
  pathname,
}: {
  node: SidebarNavNode;
  depth: number;
  collapsed: Set<string>;
  onToggleCollapse: (id: string) => void;
  pathname: string;
}) {
  const leafHyphen = node.showLeafHyphen !== false;
  const hasChildren = (node.children?.length ?? 0) > 0;
  const isCollapsed = collapsed.has(node.id);
  const isActive = sidebarNodeMatchesPath(pathname, node);
  const showChildren = hasChildren && !isCollapsed;

  const collapse = (e: MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    onToggleCollapse(node.id);
  };

  return (
    <li className={styles.item} style={{ "--sidebar-depth": depth } as CSSProperties}>
      <div className={styles.itemBody}>
        {hasChildren ? (
          <button
            type="button"
            className={styles.expand}
            aria-label={isCollapsed ? `Expand ${node.label}` : `Collapse ${node.label}`}
            aria-expanded={!isCollapsed}
            onClick={collapse}
          >
            <span className={styles.expandCaret}>
              <CaretIcon expanded={!isCollapsed} />
            </span>
            {showChildren ? (
              <>
                <span className={styles.expandRail} aria-hidden />
                <span className={styles.expandRailSpace} aria-hidden />
              </>
            ) : null}
          </button>
        ) : (
          <span className={styles.leafMark} aria-hidden>
            {leafHyphen ? <span className={styles.leafHyphen} /> : null}
          </span>
        )}
        <div className={styles.itemContent}>
          <div className={`${styles.row}${isActive ? ` ${styles.rowActive}` : ""}`}>
            <NavLink
              to={node.to}
              end={node.end}
              className={({ isActive: linkActive }) =>
                `${styles.link}${linkActive || isActive ? ` ${styles.linkActive}` : ""}`
              }
            >
              {node.label}
            </NavLink>
          </div>
          {showChildren ? (
            <ul className={styles.sublist}>
              {node.children!.map((child) => (
                <SidebarNavItem
                  key={child.id}
                  node={child}
                  depth={depth + 1}
                  collapsed={collapsed}
                  onToggleCollapse={onToggleCollapse}
                  pathname={pathname}
                />
              ))}
            </ul>
          ) : null}
        </div>
      </div>
    </li>
  );
}

function unreadBadgeLabel(count: number): string | null {
  if (count <= 0) return null;
  if (count > 9) return "9+";
  return String(count);
}

export function AppSidebar() {
  const { t } = useTranslation();
  const { pathname } = useLocation();
  const [unreadCount, setUnreadCount] = useState(0);
  const [accounts, setAccounts] = useState<{
    cash: AccountListRow[];
    liabilities: AccountListRow[];
    realEstate: AccountListRow[];
    inversiones: AccountListRow[];
  } | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(readCollapsedIds);

  const refreshUnread = useCallback(() => {
    void api.messagesUnreadCount().then(
      (d) => setUnreadCount(d.count),
      () => setUnreadCount(0)
    );
  }, []);

  useEffect(() => {
    refreshUnread();
    const onRead = () => refreshUnread();
    window.addEventListener("nw-messages-read", onRead);
    const id = window.setInterval(refreshUnread, 60_000);
    return () => {
      window.removeEventListener("nw-messages-read", onRead);
      window.clearInterval(id);
    };
  }, [refreshUnread]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [cash, liabilities, realEstate, inversiones] = await Promise.all([
          api.accountsByGroup("cash_eqs"),
          api.accountsByGroup("liabilities"),
          api.accountsByGroup("real_estate"),
          api.accountsByGroup("inversiones"),
        ]);
        if (!cancelled) {
          setAccounts({
            cash: cash.accounts,
            liabilities: liabilities.accounts,
            realEstate: realEstate.accounts,
            inversiones: inversiones.accounts,
          });
        }
      } catch {
        if (!cancelled) {
          setAccounts({ cash: [], liabilities: [], realEstate: [], inversiones: [] });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const tree = useMemo(() => {
    if (!accounts) return null;
    return buildSidebarNavTree({
      cash: accounts.cash,
      liabilities: accounts.liabilities,
      realEstate: accounts.realEstate,
      inversiones: accounts.inversiones,
    });
  }, [accounts]);

  useEffect(() => {
    if (!tree) return;
    const expandIds = collectAncestorIdsToExpand(tree, pathname);
    if (expandIds.length === 0) return;
    setCollapsed((prev) => {
      const next = new Set(prev);
      let changed = false;
      for (const id of expandIds) {
        if (next.delete(id)) changed = true;
      }
      if (changed) writeCollapsedIds(next);
      return changed ? next : prev;
    });
  }, [pathname, tree]);

  const onToggleCollapse = useCallback((id: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      writeCollapsedIds(next);
      return next;
    });
  }, []);

  const dashboardNode = tree?.find((n) => n.id === "dashboard");
  const mainNavNodes =
    tree?.filter((n) => n.id !== "flows" && n.id !== "rates" && n.id !== "dashboard") ?? [];
  const flowsNode = tree?.find((n) => n.id === "flows");
  const ratesNode = tree?.find((n) => n.id === "rates");
  const unreadPill = unreadBadgeLabel(unreadCount);

  return (
    <aside className="app-sidebar" aria-label="Main navigation">
      <div className={styles.brand}>
        <NavLink to="/">NW Tracker</NavLink>
      </div>
      <nav className={styles.nav}>
        <div className={styles.navInner}>
          <div className={styles.navScroll}>
            {!tree ? (
              <p className={`${styles.loading} muted`}>{t("common.loading")}</p>
            ) : (
              <>
                <ul className={styles.list}>
                  {dashboardNode ? (
                    <SidebarNavItem
                      key={dashboardNode.id}
                      node={dashboardNode}
                      depth={0}
                      collapsed={collapsed}
                      onToggleCollapse={onToggleCollapse}
                      pathname={pathname}
                    />
                  ) : null}
                </ul>
                <div className={styles.separator} role="separator" />
                <ul className={styles.list}>
                  {mainNavNodes.map((node) => (
                    <SidebarNavItem
                      key={node.id}
                      node={node}
                      depth={0}
                      collapsed={collapsed}
                      onToggleCollapse={onToggleCollapse}
                      pathname={pathname}
                    />
                  ))}
                </ul>
                <div className={styles.separator} role="separator" />
                <ul className={styles.list}>
                  {flowsNode ? (
                    <SidebarNavItem
                      node={flowsNode}
                      depth={0}
                      collapsed={collapsed}
                      onToggleCollapse={onToggleCollapse}
                      pathname={pathname}
                    />
                  ) : null}
                </ul>
                <div className={styles.separator} role="separator" />
                <ul className={styles.list}>
                  {ratesNode ? (
                    <SidebarNavItem
                      node={ratesNode}
                      depth={0}
                      collapsed={collapsed}
                      onToggleCollapse={onToggleCollapse}
                      pathname={pathname}
                    />
                  ) : null}
                </ul>
              </>
            )}
          </div>
          <div className={styles.navSpacer} aria-hidden="true" />
          <div className={styles.navFooter}>
            <div className={styles.separator} role="separator" />
            <ul className={styles.list}>
              <li className={styles.item} style={{ "--sidebar-depth": 0 } as CSSProperties}>
                <div className={styles.itemBody}>
                  <span className={styles.leafMark} aria-hidden />
                  <div className={styles.itemContent}>
                    <div
                      className={`${styles.row}${pathname === "/messages" ? ` ${styles.rowActive}` : ""}`}
                    >
                      <NavLink
                        to="/messages"
                        className={({ isActive }) =>
                          `${styles.link}${isActive ? ` ${styles.linkActive}` : ""}`
                        }
                      >
                        <span className={styles.linkLabel}>{t("sidebar.messages")}</span>
                        {unreadPill ? (
                          <span className={styles.unreadPill} aria-label={`${unreadCount} sin leer`}>
                            {unreadPill}
                          </span>
                        ) : null}
                      </NavLink>
                    </div>
                  </div>
                </div>
              </li>
            </ul>
          </div>
        </div>
      </nav>
    </aside>
  );
}
