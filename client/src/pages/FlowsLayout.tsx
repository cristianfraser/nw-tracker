import { NavLink, Outlet } from "react-router-dom";
import { cn } from "../cn";

export function FlowsLayout() {
  return (
    <main>
      <h1>Flows</h1>
      <nav className="flow-subnav" aria-label="Flows sections">
        <NavLink to="income" className={({ isActive }) => cn(isActive && "active")}>
          Income
        </NavLink>
        <NavLink to="expenses" className={({ isActive }) => cn(isActive && "active")}>
          Expenses
        </NavLink>
        <NavLink to="deposits" className={({ isActive }) => cn(isActive && "active")}>
          Deposits
        </NavLink>
      </nav>
      <Outlet />
    </main>
  );
}
