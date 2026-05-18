import { Link, NavLink, Outlet } from "react-router-dom";

export function FlowsLayout() {
  return (
    <main className="page">
      <p className="muted">
        <Link to="/">← Dashboard</Link>
      </p>
      <h1>Flows</h1>
      <nav className="flow-subnav" aria-label="Flows sections">
        <NavLink to="income" className={({ isActive }) => (isActive ? "active" : "")}>
          Income
        </NavLink>
        <NavLink to="expenses" className={({ isActive }) => (isActive ? "active" : "")}>
          Expenses
        </NavLink>
        <NavLink to="deposits" className={({ isActive }) => (isActive ? "active" : "")}>
          Deposits
        </NavLink>
      </nav>
      <Outlet />
    </main>
  );
}
