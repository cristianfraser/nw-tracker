import { NavLink, Outlet, useLocation } from "react-router-dom";
import { cn } from "../cn";
import { useTranslation } from "../i18n";
import { FlowManualEntryForm } from "../components/flows/FlowManualEntryForm";

export function FlowsLayout() {
  const { t } = useTranslation();
  const { pathname } = useLocation();
  const showManualForm = /\/flows\/(income|expenses)$/.test(pathname);
  const defaultKind = pathname.endsWith("/expenses") ? "expense" : "income";

  return (
    <main>
      <h1>{t("flows.layoutTitle")}</h1>
      <nav className="flow-subnav" aria-label={t("flows.subnavAria")}>
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
      {showManualForm ? <FlowManualEntryForm defaultKind={defaultKind} /> : null}
      <Outlet />
    </main>
  );
}
