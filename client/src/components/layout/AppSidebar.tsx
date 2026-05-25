import { useQueryClient } from "@tanstack/react-query";
import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type CSSProperties,
  type MouseEvent,
} from "react";
import { useTranslation } from "react-i18next";
import { NavLink, useLocation } from "react-router-dom";
import { queryKeys } from "../../queries/keys";
import { useMessagesUnreadCount, useSidebarNav } from "../../queries/hooks";
import { buildSidebarNavFromApi } from "../../sidebarNavFromApi";
import {
  collectAncestorIdsToExpand,
  sidebarNodeMatchesPath,
  sidebarNodeSubtreeContainsPath,
  type SidebarNavNode,
} from "../../sidebarNavTree";
import { cn } from "../../cn";
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
      className={cn(styles.caretIcon, expanded && styles.caretIconExpanded)}
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
  const isActive =
    sidebarNodeMatchesPath(pathname, node) ||
    (hasChildren && sidebarNodeSubtreeContainsPath(pathname, node));
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
          <div className={cn(styles.row, isActive && styles.rowActive)}>
            <NavLink
              to={node.to}
              end
              className={({ isActive: linkActive }) =>
                cn(styles.link, (linkActive || isActive) && styles.linkActive)
              }
            >
              <span className={styles.linkLabel}>{node.label}</span>
              {node.badge ? (
                <span className={styles.unreadPill} aria-label={node.badgeAriaLabel}>
                  {node.badge}
                </span>
              ) : null}
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
  const queryClient = useQueryClient();
  const { data: unread } = useMessagesUnreadCount();
  const { data: navPayload } = useSidebarNav();
  const unreadCount = unread?.count ?? 0;
  const [collapsed, setCollapsed] = useState<Set<string>>(readCollapsedIds);

  useEffect(() => {
    const onRead = () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.messagesUnread() });
    };
    window.addEventListener("nw-messages-read", onRead);
    return () => window.removeEventListener("nw-messages-read", onRead);
  }, [queryClient]);

  const tree = useMemo(() => {
    if (!navPayload) return null;
    return buildSidebarNavFromApi(navPayload);
  }, [navPayload]);

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

  const panelNode = useMemo((): SidebarNavNode => {
    const notifications: SidebarNavNode = {
      id: "panel.notifications",
      label: t("sidebar.notifications"),
      to: "/panel/notifications",
      end: true,
      ...(unreadPill
        ? {
            badge: unreadPill,
            badgeAriaLabel: t("notifications.unreadBadge", { count: unreadCount }),
          }
        : {}),
    };
    return {
      id: "panel",
      label: t("sidebar.controlPanel"),
      to: "/panel",
      activePrefix: "/panel",
      showLeafHyphen: false,
      children: [
        notifications,
        {
          id: "panel.import-sync",
          label: t("sidebar.importSync"),
          to: "/panel/import-sync",
          end: true,
        },
      ],
    };
  }, [t, unreadCount, unreadPill]);

  useEffect(() => {
    const expandIds = collectAncestorIdsToExpand([panelNode], pathname);
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
  }, [pathname, panelNode]);

  return (
    <aside className="app-sidebar" aria-label="Main navigation">
      <div className={styles.brand}>
        <NavLink to="/" end>
          NW Tracker
        </NavLink>
      </div>
      <nav className={styles.nav}>
        <div className={styles.navInner}>
          <div className={styles.navScroll}>
            {!tree ? (
              <p className={cn(styles.loading, "muted")}>{t("common.loading")}</p>
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
              <SidebarNavItem
                node={panelNode}
                depth={0}
                collapsed={collapsed}
                onToggleCollapse={onToggleCollapse}
                pathname={pathname}
              />
            </ul>
          </div>
        </div>
      </nav>
    </aside>
  );
}
