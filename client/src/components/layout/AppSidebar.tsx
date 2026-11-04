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
import { useDisplayPreferences } from "../../context/DisplayPreferencesContext";
import { queryKeys } from "../../queries/keys";
import { prefetchPageShapeForPath } from "../../queries/prefetchPageShape";
import { useMessagesUnreadCount, useSidebarNav } from "../../queries/hooks";
import type { SidebarNavResponse } from "../../types";
import { buildSidebarNavFromApi } from "../../sidebarNavFromApi";
import {
  collectAncestorIdsToExpand,
  sidebarNodeMatchesPath,
  sidebarNodeSubtreeContainsPath,
  type SidebarNavNode,
} from "../../sidebarNavTree";
import { mutedPillBackgroundRgb } from "../../chartColors";
import { VISIBLE_PANEL_SUBROUTES } from "../../pages/panel/panelSubroutes";
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

function ChevronIcon() {
  return (
    <svg className={styles.chevron} width="11" height="11" viewBox="0 0 12 12" aria-hidden>
      <path
        d="M3 4.5 6 7.5l3-3"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/**
 * One row: its text starts at its depth's column (`--depth`), whatever precedes it — a group's
 * colour square and its open / close chevron hang in the margin left of the text, the chevron in
 * the square's place on hover.
 */
function SidebarNavItem({
  node,
  depth,
  collapsed,
  onToggleCollapse,
  pathname,
  navPayload,
  displayUnit,
  onPrefetchShape,
}: {
  node: SidebarNavNode;
  depth: number;
  collapsed: Set<string>;
  onToggleCollapse: (id: string) => void;
  pathname: string;
  navPayload: SidebarNavResponse | null;
  displayUnit: "clp" | "usd";
  onPrefetchShape: (targetPath: string) => void;
}) {
  const { t } = useTranslation();
  const hasChildren = (node.children?.length ?? 0) > 0;
  const isCollapsed = collapsed.has(node.id);
  const isActive = sidebarNodeMatchesPath(pathname, node);
  /** A group above the open page: its label reads bright, like the page's own. */
  const onActivePath = hasChildren && sidebarNodeSubtreeContainsPath(pathname, node);
  const showChildren = hasChildren && !isCollapsed;

  const prefetchShape = () => {
    if (!navPayload) return;
    onPrefetchShape(node.to);
  };

  const toggle = (e: MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    onToggleCollapse(node.id);
  };

  return (
    <li
      className={cn(styles.item, depth === 0 && node.markerRgb && styles.itemSection)}
      style={{ "--depth": depth } as CSSProperties}
    >
      <div className={cn(styles.row, isActive && styles.rowActive)}>
        {node.markerRgb ? (
          <span
            className={cn(
              styles.marker,
              depth > 0 && styles.markerInner,
              hasChildren && styles.markerSwap
            )}
            style={{ backgroundColor: mutedPillBackgroundRgb(node.markerRgb) }}
            aria-hidden
          />
        ) : null}
        {hasChildren ? (
          <button
            type="button"
            className={cn(
              styles.toggle,
              isCollapsed && styles.toggleCollapsed,
              node.markerRgb && styles.toggleOverMarker
            )}
            aria-label={t(isCollapsed ? "sidebar.expandGroup" : "sidebar.collapseGroup", {
              label: node.label,
            })}
            aria-expanded={!isCollapsed}
            onClick={toggle}
          >
            <ChevronIcon />
          </button>
        ) : null}
        <NavLink
          to={node.to}
          end={node.end !== false}
          className={({ isActive: linkActive }) =>
            cn(styles.link, (linkActive || isActive || onActivePath) && styles.linkActive)
          }
          onMouseEnter={prefetchShape}
          onFocus={prefetchShape}
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
              navPayload={navPayload}
              displayUnit={displayUnit}
              onPrefetchShape={onPrefetchShape}
            />
          ))}
        </ul>
      ) : null}
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
  const { displayUnit, language } = useDisplayPreferences();
  const { data: unread } = useMessagesUnreadCount();
  const { data: navPayload } = useSidebarNav();

  const onPrefetchShape = useCallback(
    (targetPath: string) => {
      if (!navPayload) return;
      prefetchPageShapeForPath(queryClient, displayUnit, navPayload, targetPath);
    },
    [queryClient, displayUnit, navPayload]
  );
  const unreadCount = unread?.count ?? 0;
  const [collapsed, setCollapsed] = useState<Set<string>>(readCollapsedIds);

  useEffect(() => {
    const onRead = () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.messagesUnread() });
    };
    window.addEventListener("nw-messages-read", onRead);
    return () => window.removeEventListener("nw-messages-read", onRead);
  }, [queryClient]);

  // `language` is a dep because buildSidebarNavFromApi resolves node labels via
  // module-level i18n.t — without it a language switch keeps the stale tree.
  const tree = useMemo(() => {
    if (!navPayload) return null;
    return buildSidebarNavFromApi(navPayload);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [navPayload, language]);

  // First-ever visit (no cached tree): only the home link, until the tree arrives. Labelled like
  // the real dashboard node (`language` is a dep for the same reason as the tree's).
  const coldDashboardNode = useMemo(
    (): SidebarNavNode => ({
      id: "dashboard",
      label: t("sidebar.dashboard"),
      to: "/",
      end: true,
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [language]
  );

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
    tree?.filter(
      (n) =>
        n.id !== "flows" &&
        n.id !== "rates" &&
        n.id !== "dashboard" &&
        n.id !== "projections" &&
        n.id !== "wealth_percentile" &&
        n.id !== "tax_return"
    ) ?? [];
  const flowsNode = tree?.find((n) => n.id === "flows");
  const projectionsNode = tree?.find((n) => n.id === "projections");
  const wealthPercentileNode = tree?.find((n) => n.id === "wealth_percentile");
  const taxReturnNode = tree?.find((n) => n.id === "tax_return");
  const ratesNode = tree?.find((n) => n.id === "rates");
  /** Rates has one child (watchlist): show both as flat links in this section (no expand). */
  const ratesSectionLinks = useMemo((): SidebarNavNode[] => {
    if (!ratesNode) return [];
    const { children, ...parent } = ratesNode;
    const out: SidebarNavNode[] = [parent];
    if (children?.length) out.push(...children);
    return out;
  }, [ratesNode]);
  const unreadPill = unreadBadgeLabel(unreadCount);

  const panelNode = useMemo((): SidebarNavNode => {
    return {
      id: "panel",
      label: t("sidebar.controlPanel"),
      to: "/panel",
      activePrefix: "/panel",
      children: VISIBLE_PANEL_SUBROUTES.map((route) => ({
        id: `panel.${route.slug}`,
        label: t(route.labelKey),
        to: `/panel/${route.slug}`,
        end: true,
        ...(route.slug === "notifications" && unreadPill
          ? {
            badge: unreadPill,
            badgeAriaLabel: t("notifications.unreadBadge", { count: unreadCount }),
          }
          : {}),
      })),
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
    <aside className="app-sidebar" aria-label={t("sidebar.mainNavAria")}>
      <div className={styles.brand}>
        <NavLink
          to="/"
          end
          onMouseEnter={() => onPrefetchShape("/")}
          onFocus={() => onPrefetchShape("/")}
        >
          NW Tracker
        </NavLink>
      </div>
      <nav className={styles.nav}>
        <div className={styles.navInner}>
          <div className={styles.navScroll}>
            {!tree ? (
              <>
                <ul className={styles.list}>
                  <SidebarNavItem
                    node={coldDashboardNode}
                    depth={0}
                    collapsed={collapsed}
                    onToggleCollapse={onToggleCollapse}
                    pathname={pathname}
                    navPayload={null}
                    displayUnit={displayUnit}
                    onPrefetchShape={onPrefetchShape}
                  />
                </ul>
              </>
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
                      navPayload={navPayload ?? null}
                      displayUnit={displayUnit}
                      onPrefetchShape={onPrefetchShape}
                    />
                  ) : null}
                </ul>
                <ul className={styles.list}>
                  {mainNavNodes.map((node) => (
                    <SidebarNavItem
                      key={node.id}
                      node={node}
                      depth={0}
                      collapsed={collapsed}
                      onToggleCollapse={onToggleCollapse}
                      pathname={pathname}
                      navPayload={navPayload ?? null}
                      displayUnit={displayUnit}
                      onPrefetchShape={onPrefetchShape}
                    />
                  ))}
                </ul>
                <div className={styles.separator} role="separator" />
                <ul className={styles.list}>
                  {projectionsNode ? (
                    <SidebarNavItem
                      node={projectionsNode}
                      depth={0}
                      collapsed={collapsed}
                      onToggleCollapse={onToggleCollapse}
                      pathname={pathname}
                      navPayload={navPayload ?? null}
                      displayUnit={displayUnit}
                      onPrefetchShape={onPrefetchShape}
                    />
                  ) : null}
                  {wealthPercentileNode ? (
                    <SidebarNavItem
                      node={wealthPercentileNode}
                      depth={0}
                      collapsed={collapsed}
                      onToggleCollapse={onToggleCollapse}
                      pathname={pathname}
                      navPayload={navPayload ?? null}
                      displayUnit={displayUnit}
                      onPrefetchShape={onPrefetchShape}
                    />
                  ) : null}
                  {taxReturnNode ? (
                    <SidebarNavItem
                      node={taxReturnNode}
                      depth={0}
                      collapsed={collapsed}
                      onToggleCollapse={onToggleCollapse}
                      pathname={pathname}
                      navPayload={navPayload ?? null}
                      displayUnit={displayUnit}
                      onPrefetchShape={onPrefetchShape}
                    />
                  ) : null}
                  {flowsNode ? (
                    <SidebarNavItem
                      node={flowsNode}
                      depth={0}
                      collapsed={collapsed}
                      onToggleCollapse={onToggleCollapse}
                      pathname={pathname}
                      navPayload={navPayload ?? null}
                      displayUnit={displayUnit}
                      onPrefetchShape={onPrefetchShape}
                    />
                  ) : null}
                </ul>
                <div className={styles.separator} role="separator" />
                <ul className={styles.list}>
                  {ratesSectionLinks.map((node) => (
                    <SidebarNavItem
                      key={node.id}
                      node={node}
                      depth={0}
                      collapsed={collapsed}
                      onToggleCollapse={onToggleCollapse}
                      pathname={pathname}
                      navPayload={navPayload ?? null}
                      displayUnit={displayUnit}
                      onPrefetchShape={onPrefetchShape}
                    />
                  ))}
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
                navPayload={navPayload ?? null}
                displayUnit={displayUnit}
                onPrefetchShape={onPrefetchShape}
              />
            </ul>
          </div>
        </div>
      </nav>
    </aside>
  );
}
