import { useQueryClient } from "@tanstack/react-query";
import { ChevronIcon } from "../ui/ChevronIcon";
import { ColorMarker } from "../ui/ColorMarker";
import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type CSSProperties,
  type MouseEvent,
} from "react";
import { useTranslation } from "react-i18next";
import { Link, NavLink, useLocation } from "react-router-dom";
import { useDisplayPreferences } from "../../context/DisplayPreferencesContext";
import { prefetchPageShapeForPath } from "../../queries/prefetchPageShape";
import { useMessagesUnreadCount, useSidebarNav } from "../../queries/hooks";
import type { SidebarNavResponse } from "../../types";
import { buildSidebarNavFromApi } from "../../sidebarNavFromApi";
import {
  collectAncestorIdsToExpand,
  sidebarNodeMatchesPath,
  sidebarNodeSubtreeContainsPath,
  type SidebarNavMarker,
  type SidebarNavNode,
} from "../../sidebarNavTree";
// The hand-drawn marks, imported directly: a lazy load painted the flat marks first on every page
// load and swapped them when its chunk arrived (the sketch code ships with the first load anyway).
import { VISIBLE_PANEL_SUBROUTES } from "../../pages/panel/panelSubroutes";
import { DEMO_TOUR_ENABLED, startDemoTour } from "./DemoTour";
import { DASHBOARD_PATH, DEMO_BUILD } from "../../dashboardPath";
import { cn } from "../../cn";
import styles from "./AppSidebar.module.css";
import type { DisplayUnit } from "../../queries/keys";

/**
 * The viewer's explicit open / closed choices by node id; a group without one follows
 * `openByDefault`. v2: the default became «every group open but leaf groups» — the v1 key (a
 * set of closed ids under an all-open default) is no longer read.
 */
const OPEN_STORAGE_KEY = "nw-sidebar-open.v2";
const LEGACY_COLLAPSE_STORAGE_KEY = "nw-sidebar-collapsed";

type OpenChoices = Record<string, boolean>;

function readOpenChoices(): OpenChoices {
  try {
    localStorage.removeItem(LEGACY_COLLAPSE_STORAGE_KEY);
    const raw = localStorage.getItem(OPEN_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (parsed == null || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: OpenChoices = {};
    for (const [id, open] of Object.entries(parsed)) if (typeof open === "boolean") out[id] = open;
    return out;
  } catch {
    return {};
  }
}

function writeOpenChoices(choices: OpenChoices) {
  try {
    localStorage.setItem(OPEN_STORAGE_KEY, JSON.stringify(choices));
  } catch {
    // Storage unavailable (private mode): the choice lasts this page view.
  }
}

/** Every group starts open except a leaf group (one whose rows include accounts). */
function openByDefault(node: SidebarNavNode): boolean {
  return node.holdsAccounts !== true;
}

function isNodeOpen(choices: OpenChoices, node: SidebarNavNode): boolean {
  return choices[node.id] ?? openByDefault(node);
}

/**
 * A row's mark (a group's colour square, the expenses triangle): flat in the plain chart style,
 * hand-drawn in the others (the box legend's square, the triangle in the same hand).
 */
function RowMarker({ marker, swap }: { marker: SidebarNavMarker; swap: boolean }) {
  return (
    <ColorMarker
      color={marker.color}
      shape={marker.shape}
      className={cn(styles.marker, swap && styles.markerSwap)}
    />
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
  openChoices,
  onToggleOpen,
  pathname,
  navPayload,
  displayUnit,
  onPrefetchShape,
  tourTarget,
}: {
  node: SidebarNavNode;
  depth: number;
  openChoices: OpenChoices;
  onToggleOpen: (node: SidebarNavNode) => void;
  pathname: string;
  navPayload: SidebarNavResponse | null;
  displayUnit: DisplayUnit;
  onPrefetchShape: (targetPath: string) => void;
  /** `data-tour` name the demo tour points at (DemoTour.tsx). */
  tourTarget?: string;
}) {
  const { t } = useTranslation();
  const hasChildren = (node.children?.length ?? 0) > 0;
  const isCollapsed = !isNodeOpen(openChoices, node);
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
    onToggleOpen(node);
  };

  return (
    <li
      className={cn(styles.item, depth === 0 && node.marker?.shape === "square" && styles.itemSection)}
      style={{ "--depth": depth } as CSSProperties}
      data-tour={tourTarget}
    >
      <div className={cn(styles.row, isActive && styles.rowActive)}>
        {node.marker ? <RowMarker marker={node.marker} swap={hasChildren} /> : null}
        {hasChildren ? (
          <button
            type="button"
            className={cn(
              styles.toggle,
              isCollapsed && styles.toggleCollapsed,
              node.marker && styles.toggleOverMarker
            )}
            aria-label={t(isCollapsed ? "sidebar.expandGroup" : "sidebar.collapseGroup", {
              label: node.label,
            })}
            aria-expanded={!isCollapsed}
            onClick={toggle}
          >
            <ChevronIcon className={styles.chevron} />
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
              openChoices={openChoices}
              onToggleOpen={onToggleOpen}
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
  const [openChoices, setOpenChoices] = useState<OpenChoices>(readOpenChoices);

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
      to: DASHBOARD_PATH,
      end: true,
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [language]
  );

  useEffect(() => {
    if (!tree) return;
    const expandIds = collectAncestorIdsToExpand(tree, pathname);
    if (expandIds.length === 0) return;
    setOpenChoices((prev) => {
      let changed = false;
      const next = { ...prev };
      for (const id of expandIds) {
        if (next[id] !== true) {
          next[id] = true;
          changed = true;
        }
      }
      if (changed) writeOpenChoices(next);
      return changed ? next : prev;
    });
  }, [pathname, tree]);

  const onToggleOpen = useCallback((node: SidebarNavNode) => {
    setOpenChoices((prev) => {
      const next = { ...prev, [node.id]: !isNodeOpen(prev, node) };
      writeOpenChoices(next);
      return next;
    });
  }, []);

  const serverDashboardNode = tree?.find((n) => n.id === "dashboard");
  // The server's node points at `/`; on the demo that is the About page.
  const dashboardNode = serverDashboardNode ? { ...serverDashboardNode, to: DASHBOARD_PATH } : undefined;
  const aboutNode = useMemo(
    (): SidebarNavNode | null =>
      DEMO_BUILD ? { id: "about", label: t("demo.about.navLabel"), to: "/", end: true } : null,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [language]
  );
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
    setOpenChoices((prev) => {
      let changed = false;
      const next = { ...prev };
      for (const id of expandIds) {
        if (next[id] !== true) {
          next[id] = true;
          changed = true;
        }
      }
      if (changed) writeOpenChoices(next);
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
                  {aboutNode ? (
                    <SidebarNavItem
                      node={aboutNode}
                      depth={0}
                      openChoices={openChoices}
                      onToggleOpen={onToggleOpen}
                      pathname={pathname}
                      navPayload={null}
                      displayUnit={displayUnit}
                      onPrefetchShape={onPrefetchShape}
                    />
                  ) : null}
                  <SidebarNavItem
                    node={coldDashboardNode}
                    depth={0}
                    openChoices={openChoices}
                    onToggleOpen={onToggleOpen}
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
                  {aboutNode ? (
                    <SidebarNavItem
                      node={aboutNode}
                      depth={0}
                      openChoices={openChoices}
                      onToggleOpen={onToggleOpen}
                      pathname={pathname}
                      navPayload={navPayload ?? null}
                      displayUnit={displayUnit}
                      onPrefetchShape={onPrefetchShape}
                    />
                  ) : null}
                  {dashboardNode ? (
                    <SidebarNavItem
                      key={dashboardNode.id}
                      node={dashboardNode}
                      depth={0}
                      openChoices={openChoices}
                      onToggleOpen={onToggleOpen}
                      pathname={pathname}
                      navPayload={navPayload ?? null}
                      displayUnit={displayUnit}
                      onPrefetchShape={onPrefetchShape}
                    />
                  ) : null}
                </ul>
                <ul className={styles.list} data-tour="nav-groups">
                  {mainNavNodes.map((node) => (
                    <SidebarNavItem
                      key={node.id}
                      node={node}
                      depth={0}
                      openChoices={openChoices}
                      onToggleOpen={onToggleOpen}
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
                      openChoices={openChoices}
                      onToggleOpen={onToggleOpen}
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
                      openChoices={openChoices}
                      onToggleOpen={onToggleOpen}
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
                      openChoices={openChoices}
                      onToggleOpen={onToggleOpen}
                      pathname={pathname}
                      navPayload={navPayload ?? null}
                      displayUnit={displayUnit}
                      onPrefetchShape={onPrefetchShape}
                    />
                  ) : null}
                  {flowsNode ? (
                    <SidebarNavItem
                      node={flowsNode}
                      tourTarget="nav-flows"
                      depth={0}
                      openChoices={openChoices}
                      onToggleOpen={onToggleOpen}
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
                      openChoices={openChoices}
                      onToggleOpen={onToggleOpen}
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
                openChoices={openChoices}
                onToggleOpen={onToggleOpen}
                pathname={pathname}
                navPayload={navPayload ?? null}
                displayUnit={displayUnit}
                onPrefetchShape={onPrefetchShape}
              />
            </ul>
            {DEMO_TOUR_ENABLED ? (
              <div className={styles.demoLinks}>
                <button type="button" className={styles.demoLink} onClick={startDemoTour}>
                  {t("demo.footer.tour")}
                </button>
                <Link to="/privacy" className={styles.demoLink}>
                  {t("demo.footer.privacy")}
                </Link>
              </div>
            ) : null}
          </div>
        </div>
      </nav>
    </aside>
  );
}
