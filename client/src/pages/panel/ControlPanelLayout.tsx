import { NavLink, Outlet } from "react-router-dom";
import { useTranslation } from "../../i18n";
import { cn } from "../../cn";

export function ControlPanelLayout() {
  const { t } = useTranslation();

  return (
    <main>
      <h1>{t("panel.layoutTitle")}</h1>
      <nav className="flow-subnav" aria-label={t("panel.subnavAria")}>
        <NavLink to="notifications" className={({ isActive }) => cn(isActive && "active")}>
          {t("panel.notificationsTitle")}
        </NavLink>
        <NavLink to="accounts" className={({ isActive }) => cn(isActive && "active")}>
          {t("panel.accountsTitle")}
        </NavLink>
        <NavLink to="import-sync" className={({ isActive }) => cn(isActive && "active")}>
          {t("panel.importSyncTitle")}
        </NavLink>
        <NavLink to="mirror-pairs" className={({ isActive }) => cn(isActive && "active")}>
          {t("panel.mirrorPairsTitle")}
        </NavLink>
        <NavLink to="settings" className={({ isActive }) => cn(isActive && "active")}>
          {t("panel.settingsTitle")}
        </NavLink>
      </nav>
      <Outlet />
    </main>
  );
}
