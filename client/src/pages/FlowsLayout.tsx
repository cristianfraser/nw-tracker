import { NavLink, Outlet } from "react-router-dom";
import { cn } from "../cn";
import { useTranslation } from "../i18n";
import { useSidebarNav } from "../queries/hooks";
import { resolveNavTreeLabel, visibleNavChildren } from "../sidebarNavFromApi";

export function FlowsLayout() {
  const { t } = useTranslation();
  const { data: nav } = useSidebarNav();
  // Tabs derive from the same master the sidebar reads (`/api/meta/sidebar-nav` →
  // flows node, seeded server-side in seedNavTree). Payload order = seed order.
  const flowTabs = visibleNavChildren(nav?.flows?.children ?? []);

  return (
    <main>
      <h1>{t("flows.layoutTitle")}</h1>
      <nav className="flow-subnav" aria-label={t("flows.subnavAria")}>
        <NavLink to="." end className={({ isActive }) => cn(isActive && "active")}>
          {t("flows.overview.title")}
        </NavLink>
        {flowTabs.map((tab) => (
          <NavLink
            key={tab.node_id}
            to={tab.route_path}
            className={({ isActive }) => cn(isActive && "active")}
          >
            {resolveNavTreeLabel(tab)}
          </NavLink>
        ))}
      </nav>
      <Outlet />
    </main>
  );
}
