import { useEffect, useState } from "react";
import { Cell, Legend, Pie, PieChart, ResponsiveContainer, Tooltip } from "recharts";
import { api } from "../api";
import { formatClp, formatUsd, clpToUsd } from "../format";
import type { DashboardResponse, FxLatest } from "../types";

const COLORS = ["#3d9cf9", "#34d399", "#a78bfa", "#fbbf24", "#f472b6", "#94a3b8"];

export function DashboardPage() {
  const [dash, setDash] = useState<DashboardResponse | null>(null);
  const [fx, setFx] = useState<FxLatest | null>(null);
  const [showUsd, setShowUsd] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [d, f] = await Promise.all([api.dashboard(showUsd), api.fxLatest()]);
        if (!cancelled) {
          setDash(d);
          setFx(f);
        }
      } catch (e) {
        if (!cancelled) setErr(e instanceof Error ? e.message : "Failed to load");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [showUsd]);

  if (err) {
    return (
      <main className="page">
        <p className="error">{err}</p>
        <p className="muted">Start the API: <span className="mono">cd server && npm run dev</span></p>
      </main>
    );
  }

  if (!dash) {
    return (
      <main className="page">
        <p className="muted">Loading…</p>
      </main>
    );
  }

  const rate = fx?.clp_per_usd;
  const fmtClp = (clp: number) => formatClp(clp);
  const fmtUsdPos = (usd: number | null | undefined) =>
    usd != null ? formatUsd(usd) : "—";
  const fmtFlow = (clp: number) =>
    showUsd && rate ? formatUsd(clpToUsd(clp, rate)) : formatClp(clp);

  const useUsdPie =
    showUsd &&
    dash.totals.current_value_usd != null &&
    dash.totals.current_value_usd > 0;

  const pieData = dash.allocation.map((a) => ({
    name: a.group_label,
    value: useUsdPie && a.value_usd != null ? a.value_usd : a.value_clp,
  }));

  return (
    <main className="page">
      <h1>Dashboard</h1>
      <div className="toggle-row">
        <label>
          <input
            type="checkbox"
            checked={showUsd}
            onChange={(e) => setShowUsd(e.target.checked)}
            disabled={!rate}
          />{" "}
          Show USD (positions use FX on or before each valuation date; flows use latest rate
          {fx ? ` ${fx.date}: ${rate?.toLocaleString("es-CL")} CLP/USD` : ""})
        </label>
        {!rate && (
          <span className="muted">
            — add FX via <span className="mono">POST /api/fx</span> to enable USD
          </span>
        )}
      </div>

      <div className="cards">
        <div className="card">
          <div className="label">Current value</div>
          <div className="value mono">
            {showUsd && dash.totals.current_value_usd != null
              ? formatUsd(dash.totals.current_value_usd)
              : fmtClp(dash.totals.current_value_clp)}
          </div>
        </div>
        <div className="card">
          <div className="label">Deposits (tracked)</div>
          <div className="value mono">{fmtFlow(dash.totals.deposits_clp)}</div>
          {showUsd && <div className="muted" style={{ fontSize: "0.7rem", marginTop: "0.25rem" }}>approx.</div>}
        </div>
        <div className="card">
          <div className="label">Withdrawals</div>
          <div className="value mono">{fmtFlow(dash.totals.withdrawals_clp)}</div>
          {showUsd && <div className="muted" style={{ fontSize: "0.7rem", marginTop: "0.25rem" }}>approx.</div>}
        </div>
      </div>

      <h2>Allocation (latest valuations)</h2>
      {pieData.length === 0 ? (
        <p className="empty">Add accounts and valuations to see the chart.</p>
      ) : (
        <div className="chart-box">
          <ResponsiveContainer width="100%" height="100%">
            <PieChart>
              <Pie data={pieData} dataKey="value" nameKey="name" cx="50%" cy="50%" outerRadius={100} label>
                {pieData.map((_, i) => (
                  <Cell key={i} fill={COLORS[i % COLORS.length]} />
                ))}
              </Pie>
              <Tooltip
                formatter={(v: number) => (useUsdPie ? formatUsd(v) : formatClp(v))}
              />
              <Legend />
            </PieChart>
          </ResponsiveContainer>
        </div>
      )}

      <h2>Accounts</h2>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Account</th>
              <th>Class</th>
              <th>Category</th>
              <th>Deposits</th>
              <th>Withdrawals</th>
              <th>Current value</th>
              <th>As of</th>
            </tr>
          </thead>
          <tbody>
            {dash.accounts.length === 0 ? (
              <tr>
                <td colSpan={7} className="muted">
                  No accounts yet. Open an asset tab and note category IDs for{" "}
                  <span className="mono">POST /api/accounts</span>.
                </td>
              </tr>
            ) : (
              dash.accounts.map((a) => (
                <tr key={a.account_id}>
                  <td>{a.name}</td>
                  <td>{a.group_label}</td>
                  <td>{a.category_label}</td>
                  <td className="mono">{fmtFlow(a.deposits_clp)}</td>
                  <td className="mono">{fmtFlow(a.withdrawals_clp)}</td>
                  <td className="mono">
                    {showUsd
                      ? fmtUsdPos(a.current_value_usd ?? null)
                      : a.current_value_clp != null
                        ? fmtClp(a.current_value_clp)
                        : "—"}
                  </td>
                  <td className="muted">{a.valuation_as_of ?? "—"}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </main>
  );
}
