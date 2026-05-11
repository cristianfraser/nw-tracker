import { NavLink, Route, Routes } from "react-router-dom";
import { AccountDetailPage } from "./pages/AccountDetailPage";
import { AssetGroupPage } from "./pages/AssetGroupPage";
import { DashboardPage } from "./pages/DashboardPage";
import { ExpensesPage } from "./pages/ExpensesPage";
import { IncomePage } from "./pages/IncomePage";

const nav = [
  { to: "/", label: "Dashboard", end: true },
  { to: "/retirement", label: "Retirement" },
  { to: "/brokerage", label: "Brokerage" },
  { to: "/cash_eqs", label: "Cash & equivalents" },
  { to: "/crypto", label: "Crypto" },
  { to: "/real_estate", label: "Real estate" },
  { to: "/liabilities", label: "Liabilities" },
  { to: "/income", label: "Income" },
  { to: "/expenses", label: "Expenses" },
];

export default function App() {
  return (
    <div className="layout">
      <header className="topnav">
        <span className="brand">
          <NavLink to="/">NW Tracker</NavLink>
        </span>
        {nav.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            end={item.end}
            className={({ isActive }) => (isActive ? "active" : "")}
          >
            {item.label}
          </NavLink>
        ))}
      </header>
      <Routes>
        <Route path="/" element={<DashboardPage />} />
        <Route path="/retirement" element={<AssetGroupPage slug="retirement" title="Retirement" />} />
        <Route path="/brokerage" element={<AssetGroupPage slug="brokerage" title="Brokerage" />} />
        <Route path="/cash_eqs" element={<AssetGroupPage slug="cash_eqs" title="Cash & equivalents" />} />
        <Route path="/crypto" element={<AssetGroupPage slug="crypto" title="Crypto" />} />
        <Route path="/real_estate" element={<AssetGroupPage slug="real_estate" title="Real estate" />} />
        <Route path="/liabilities" element={<AssetGroupPage slug="liabilities" title="Liabilities" />} />
        <Route path="/income" element={<IncomePage />} />
        <Route path="/expenses" element={<ExpensesPage />} />
        <Route path="/account/:id" element={<AccountDetailPage />} />
      </Routes>
    </div>
  );
}
