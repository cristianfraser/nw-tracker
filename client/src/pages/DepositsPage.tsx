import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api";
import { DepositsByCategoryChart } from "../components/DepositsByCategoryChart";
import { Table } from "../components/Table";
import type { DashboardChartGranularity } from "../dashboardTimeseriesYearly";
import { formatClp } from "../format";
import type { DepositFlowCategory, FlowsDepositsResponse } from "../types";

const CATEGORY_ORDER: DepositFlowCategory[] = ["real_estate", "cash", "brokerage", "inversiones"];

export function DepositsPage() {
  const [data, setData] = useState<FlowsDepositsResponse | null>(null);
  const [granularity, setGranularity] = useState<DashboardChartGranularity>("monthly");
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const d = await api.flowsDeposits();
        if (!cancelled) setData(d);
      } catch (e) {
        if (!cancelled) setErr(e instanceof Error ? e.message : "Failed to load");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const chartPoints = useMemo(() => {
    if (!data) return [];
    return granularity === "yearly" ? data.chart_yearly : data.chart_monthly;
  }, [data, granularity]);

  if (err) {
    return <p className="error">{err}</p>;
  }

  if (!data) {
    return <p className="muted">Loading deposits…</p>;
  }

  return (
    <>
      <h2 className="flow-section-title">Deposits</h2>
      <p className="muted" style={{ maxWidth: "52rem", marginBottom: "0.75rem" }}>
        Net external capital by category (deposits positive, withdrawals negative). Same merged timeline as
        account “aportes” / chart deposit lines: movements plus brokerage CLP wires and withdrawals.
      </p>

      <div className="chart-controls" style={{ marginBottom: "0.75rem" }}>
        <span className="label-inline">Gráfico</span>
        <label className="radio-pill">
          <input
            type="radio"
            name="deposits-granularity"
            checked={granularity === "monthly"}
            onChange={() => setGranularity("monthly")}
          />
          Mensual
        </label>
        <label className="radio-pill">
          <input
            type="radio"
            name="deposits-granularity"
            checked={granularity === "yearly"}
            onChange={() => setGranularity("yearly")}
          />
          Anual
        </label>
      </div>

      <div className="chart-grid chart-grid--full-line chart-grid--full-width-stack" style={{ marginBottom: "1.5rem" }}>
        <DepositsByCategoryChart
          title="Aportes por categoría"
          points={chartPoints}
          xAxisGranularity={granularity === "yearly" ? "year" : "month"}
        />
      </div>

      {CATEGORY_ORDER.map((cat) => {
        const block = data.by_category[cat];
        return (
          <section key={cat} style={{ marginBottom: "1.5rem" }}>
            <h3 style={{ fontSize: "1.05rem", marginBottom: "0.35rem" }}>
              {block.label}
              <span className="muted mono" style={{ fontSize: "0.85rem", marginLeft: "0.5rem" }}>
                {formatClp(block.total_clp)}
              </span>
            </h3>
            <Table
              tableStyle={{ fontSize: "0.85rem" }}
              header={
                <thead>
                  <tr>
                    <th>Date</th>
                    <th>Category</th>
                    <th>Account</th>
                    <th>Amount</th>
                  </tr>
                </thead>
              }
            >
              {block.rows.length === 0 ? (
                <tr>
                  <td colSpan={4} className="muted">
                    No deposits in this category.
                  </td>
                </tr>
              ) : (
                block.rows.map((r, idx) => (
                  <tr key={`${r.account_id}-${r.occurred_on}-${idx}`}>
                    <td className="mono">{r.occurred_on}</td>
                    <td>{r.category_label}</td>
                    <td>
                      <Link to={`/account/${r.account_id}`}>{r.account_name}</Link>
                    </td>
                    <td className="mono">{formatClp(r.amount_clp)}</td>
                  </tr>
                ))
              )}
            </Table>
          </section>
        );
      })}
    </>
  );
}
