import { NavLink, Outlet } from "react-router-dom";
import { cn } from "../cn";
import { useTranslation } from "../i18n";

export function FlowsLayout() {
  const { t } = useTranslation();

  return (
    <main>
      <h1>{t("flows.layoutTitle")}</h1>
      <nav className="flow-subnav" aria-label={t("flows.subnavAria")}>
        <NavLink to="." end className={({ isActive }) => cn(isActive && "active")}>
          {t("flows.overview.title")}
        </NavLink>
        <NavLink to="income" className={({ isActive }) => cn(isActive && "active")}>
          {t("sidebar.flowsIncome")}
        </NavLink>
        <NavLink to="expenses" className={({ isActive }) => cn(isActive && "active")}>
          {t("sidebar.flowsExpenses")}
        </NavLink>
        <NavLink to="deposits" className={({ isActive }) => cn(isActive && "active")}>
          {t("sidebar.flowsDeposits")}
        </NavLink>
      </nav>
      <Outlet />
    </main>
  );
}
