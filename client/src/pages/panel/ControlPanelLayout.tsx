import { Suspense } from "react";
import { NavLink, Outlet } from "react-router-dom";
import { useTranslation } from "../../i18n";
import { cn } from "../../cn";
import { PANEL_SUBROUTES } from "./panelSubroutes";

export function ControlPanelLayout() {
  const { t } = useTranslation();

  return (
    <main>
      <h1>{t("panel.layoutTitle")}</h1>
      <nav className="flow-subnav" aria-label={t("panel.subnavAria")}>
        {PANEL_SUBROUTES.map((route) => (
          <NavLink
            key={route.slug}
            to={route.slug}
            className={({ isActive }) => cn(isActive && "active")}
          >
            {t(route.labelKey)}
          </NavLink>
        ))}
      </nav>
      {/* A direct load of a tab keeps this heading and the tabs while the tab's chunk loads. */}
      <Suspense fallback={null}>
        <Outlet />
      </Suspense>
    </main>
  );
}
