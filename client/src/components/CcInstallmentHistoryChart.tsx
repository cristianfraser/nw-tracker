import { useMemo } from "react";
import {
  Bar,
  CartesianGrid,
  ComposedChart,
  Legend,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { CcInstallmentHistoryMonthPoint } from "../types";
import { formatClp } from "../format";
import { buildNiceYAxis, RECHARTS_MONEY_CHART_MARGIN } from "./ValuationLineCharts";

const AXIS_STROKE = "#64748b";

function formatYmEs(ym: string): string {
  const [ys, ms] = ym.split("-");
  const m = Number(ms);
  const names = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];
  const label = m >= 1 && m <= 12 ? names[m - 1] : ym;
  return `${label} ${ys}`;
}

function minMax(
  points: { remaining_balance_clp: number; installment_payments_clp: number }[],
  key: "remaining_balance_clp" | "installment_payments_clp"
) {
  let minV = Infinity;
  let maxV = -Infinity;
  for (const row of points) {
    const v = row[key];
    if (typeof v === "number" && Number.isFinite(v)) {
      minV = Math.min(minV, v);
      maxV = Math.max(maxV, v);
    }
  }
  if (!Number.isFinite(minV)) return { min: 0, max: 0 };
  return { min: minV, max: maxV };
}

export function CcInstallmentHistoryChart({ rows }: { rows: CcInstallmentHistoryMonthPoint[] }) {
  const leftScale = useMemo(() => {
    const { min, max } = minMax(rows, "remaining_balance_clp");
    return buildNiceYAxis(min, max);
  }, [rows]);

  const rightScale = useMemo(() => {
    const { min, max } = minMax(rows, "installment_payments_clp");
    return buildNiceYAxis(Math.min(0, min), Math.max(max, 1));
  }, [rows]);

  if (rows.length === 0) {
    return <p className="muted empty">Sin historial de cuotas para esta cuenta.</p>;
  }

  return (
    <div className="chart-box line-chart-focus-wrap" style={{ height: 280, marginTop: "0.35rem" }}>
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart
          data={rows}
          margin={{ ...RECHARTS_MONEY_CHART_MARGIN, left: 4, right: 18, bottom: 4 }}
        >
          <CartesianGrid strokeDasharray="3 3" stroke="#334155" opacity={0.35} />
          <XAxis
            dataKey="month"
            type="category"
            tick={{ fontSize: 10, fill: "#94a3b8" }}
            tickFormatter={(ym: string) => formatYmEs(String(ym))}
            axisLine={{ stroke: AXIS_STROKE }}
            tickLine={{ stroke: AXIS_STROKE }}
            interval="preserveStartEnd"
          />
          <YAxis
            yAxisId="left"
            domain={leftScale.domain}
            ticks={leftScale.ticks}
            width={56}
            tick={{ fontSize: 10, fill: "#94a3b8" }}
            tickFormatter={(v: number) => formatClp(v)}
            axisLine={{ stroke: AXIS_STROKE }}
            tickLine={{ stroke: AXIS_STROKE }}
          />
          <YAxis
            yAxisId="right"
            orientation="right"
            domain={rightScale.domain}
            ticks={rightScale.ticks}
            width={52}
            tick={{ fontSize: 10, fill: "#94a3b8" }}
            tickFormatter={(v: number) => formatClp(v)}
            axisLine={{ stroke: AXIS_STROKE }}
            tickLine={{ stroke: AXIS_STROKE }}
          />
          <Tooltip
            content={({ active, payload, label }) => {
              if (!active || !payload?.length) return null;
              const d = payload[0]?.payload as CcInstallmentHistoryMonthPoint | undefined;
              if (!d) return null;
              const ledger = d.ledger_remaining_installments_clp;
              const showLedgerHint =
                ledger != null &&
                Number.isFinite(ledger) &&
                Math.round(ledger) !== Math.round(d.remaining_balance_clp);
              return (
                <div
                  style={{
                    background: "#1e293b",
                    border: "1px solid #334155",
                    fontSize: 12,
                    padding: "0.5rem 0.65rem",
                    borderRadius: 6,
                  }}
                >
                  <div style={{ marginBottom: 6, fontWeight: 600 }}>{formatYmEs(String(label))}</div>
                  <div>Saldo (línea): {formatClp(d.remaining_balance_clp)}</div>
                  <div>Pagos del mes: {formatClp(d.installment_payments_clp)}</div>
                  {showLedgerHint ? (
                    <div style={{ marginTop: 6, opacity: 0.85 }}>
                      Solo cuotas PDF (sin valorización): {formatClp(ledger)}
                    </div>
                  ) : null}
                </div>
              );
            }}
          />
          <Legend
            wrapperStyle={{ fontSize: 12, color: "var(--muted, #94a3b8)", paddingTop: 6 }}
            formatter={(value) => <span style={{ color: "var(--muted, #94a3b8)" }}>{value}</span>}
          />
          <Bar
            yAxisId="right"
            dataKey="installment_payments_clp"
            name="Pagos de cuotas (mes)"
            fill="#64748b"
            maxBarSize={32}
            radius={[2, 2, 0, 0]}
          />
          <Line
            yAxisId="left"
            type="monotone"
            dataKey="remaining_balance_clp"
            name="Saldo cierre (PDF)"
            stroke="#f472b6"
            strokeWidth={2}
            dot={{ r: 2.5, fill: "#f472b6" }}
            connectNulls
          />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}
