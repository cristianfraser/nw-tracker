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
import { useTranslation } from "../../i18n";
import type { CcHistorialChartRow } from "../../pages/accountDetail/ccChartData";
import { formatClp } from "../../format";
import { buildNiceYAxis, RECHARTS_MONEY_CHART_MARGIN } from "./ValuationLineCharts";

const AXIS_STROKE = "#64748b";

function formatYmEs(ym: string): string {
  const [ys, ms] = ym.split("-");
  const m = Number(ms);
  const names = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];
  const label = m >= 1 && m <= 12 ? names[m - 1] : ym;
  return `${label} ${ys}`;
}

function unifiedMinMax(points: CcHistorialChartRow[]) {
  let minV = 0;
  let maxV = 0;
  for (const row of points) {
    for (const v of [
      row.installment_payments_clp,
      row.facturado_clp,
      row.cupo_en_cuotas_clp,
      row.balance_total_clp,
    ]) {
      if (typeof v === "number" && Number.isFinite(v)) {
        minV = Math.min(minV, v);
        maxV = Math.max(maxV, v);
      }
    }
  }
  return { min: minV, max: Math.max(maxV, 1) };
}

const FACTURADO_FILL = "#d97706";
const CUPO_STROKE = "#f472b6";
const BALANCE_TOTAL_STROKE = "#38bdf8";

export function CcInstallmentHistoryChart({ rows }: { rows: CcHistorialChartRow[] }) {
  const { t } = useTranslation();
  const yScale = useMemo(() => {
    const { min, max } = unifiedMinMax(rows);
    return buildNiceYAxis(min, max);
  }, [rows]);

  if (rows.length === 0) {
    return <p className="muted empty">Sin historial de cuotas para esta cuenta.</p>;
  }

  return (
    <div className="chart-box line-chart-focus-wrap" style={{ height: 280, marginTop: "0.35rem" }}>
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart
          data={rows}
          margin={{ ...RECHARTS_MONEY_CHART_MARGIN, left: 4, right: 8, bottom: 4 }}
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
            domain={yScale.domain}
            ticks={yScale.ticks}
            width={56}
            tick={{ fontSize: 10, fill: "#94a3b8" }}
            tickFormatter={(v: number) => formatClp(v)}
            axisLine={{ stroke: AXIS_STROKE }}
            tickLine={{ stroke: AXIS_STROKE }}
          />
          <Tooltip
            content={({ active, payload, label }) => {
              if (!active || !payload?.length) return null;
              const d = payload[0]?.payload as CcHistorialChartRow | undefined;
              if (!d) return null;
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
                  <div>
                    {t("accountDetail.creditCard.colCupoEnCuotas")}:{" "}
                    {d.cupo_en_cuotas_clp != null ? formatClp(d.cupo_en_cuotas_clp) : "—"}
                  </div>
                  <div>
                    {t("accountDetail.creditCard.saldoTotal")}:{" "}
                    {d.balance_total_clp != null ? formatClp(d.balance_total_clp) : "—"}
                  </div>
                  <div>
                    Pagos del mes: {formatClp(d.installment_payments_clp)}
                  </div>
                  {d.facturado_clp != null && Number.isFinite(d.facturado_clp) ? (
                    <div>
                      {t("accountDetail.creditCard.chartFacturadoClose")}: {formatClp(d.facturado_clp)}
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
            dataKey="installment_payments_clp"
            name="Pagos de cuotas (mes)"
            fill="#64748b"
            maxBarSize={32}
            radius={[2, 2, 0, 0]}
          />
          <Bar
            dataKey="facturado_clp"
            name={t("accountDetail.creditCard.chartFacturadoClose")}
            fill={FACTURADO_FILL}
            maxBarSize={32}
            radius={[2, 2, 0, 0]}
          />
          <Line
            type="monotone"
            dataKey="cupo_en_cuotas_clp"
            name={t("accountDetail.creditCard.colCupoEnCuotas")}
            stroke={CUPO_STROKE}
            strokeWidth={2}
            dot={{ r: 2.5, fill: CUPO_STROKE }}
            connectNulls
          />
          <Line
            type="monotone"
            dataKey="balance_total_clp"
            name={t("accountDetail.creditCard.saldoTotal")}
            stroke={BALANCE_TOTAL_STROKE}
            strokeWidth={2}
            dot={{ r: 2.5, fill: BALANCE_TOTAL_STROKE }}
            connectNulls
          />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}
