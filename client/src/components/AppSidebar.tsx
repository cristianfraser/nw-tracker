import { useCallback, useEffect, useMemo, useState, type CSSProperties, type MouseEvent } from "react";
import { NavLink, useLocation } from "react-router-dom";
import { api } from "../api";
import {
  buildSidebarNavTree,
  collectAncestorIdsToExpand,
  sidebarNodeMatchesPath,
  type SidebarNavNode,
} from "../sidebarNavTree";
import type { AccountListRow } from "../types";

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
      className={`sidebar-caret-icon${expanded ? " sidebar-caret-icon--expanded" : ""}`}
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
    <li className="sidebar-item" style={{ "--sidebar-depth": depth } as CSSProperties}>
      <div className="sidebar-item-body">
        {hasChildren ? (
          <button
            type="button"
            className="sidebar-expand"
            aria-label={isCollapsed ? `Expand ${node.label}` : `Collapse ${node.label}`}
            aria-expanded={!isCollapsed}
            onClick={collapse}
          >
            <span className="sidebar-expand-caret">
              <CaretIcon expanded={!isCollapsed} />
            </span>
            {showChildren ? <>
              <span className="sidebar-expand-rail" aria-hidden />
              <span className="sidebar-expand-rail-space" aria-hidden />
            </> : null}
          </button>
        ) : (
          <span className="sidebar-leaf-mark" aria-hidden>
            {leafHyphen ? <span className="sidebar-leaf-hyphen" /> : null}
          </span>
        )}
        <div className="sidebar-item-content">
          <div className={`sidebar-row${isActive ? " sidebar-row--active" : ""}`}>
            <NavLink
              to={node.to}
              end={node.end}
              className={({ isActive: linkActive }) =>
                `sidebar-link${linkActive || isActive ? " active" : ""}`
              }
            >
              {node.label}
            </NavLink>
          </div>
          {showChildren ? (
            <ul className="sidebar-sublist">
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

export function AppSidebar() {
  const { pathname } = useLocation();
  const [accounts, setAccounts] = useState<{
    cash: AccountListRow[];
    liabilities: AccountListRow[];
    realEstate: AccountListRow[];
    inversiones: AccountListRow[];
  } | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(readCollapsedIds);

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

  return (
    <aside className="app-sidebar" aria-label="Main navigation">
      <div className="sidebar-brand">
        <NavLink to="/">NW Tracker</NavLink>
      </div>
      <nav className="sidebar-nav">
        {!tree ? (
          <p className="sidebar-loading muted">Loading…</p>
        ) : (
          <>
            <ul className="sidebar-list">
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
            <div className="sidebar-separator" role="separator" />
            <ul className="sidebar-list">
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
            <div className="sidebar-separator" role="separator" />
            <ul className="sidebar-list">
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
            <div className="sidebar-separator" role="separator" />
            <ul className="sidebar-list">
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
      </nav>
    </aside>
  );
}
