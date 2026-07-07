import { useMemo } from "react";
import { Bar, CartesianGrid, Legend, Line, ReferenceLine, XAxis, YAxis } from "recharts";
import { chileTodayYmd } from "../../calendarMonth";
import { useTranslation } from "../../i18n";
import type { CcHistorialChartPoint as CcHistorialChartRow } from "../../types";
import { formatClp } from "../../format";
import { AppComposedChart } from "./AppComposedChart";
import {
  buildNiceYAxis,
  RECHARTS_MONEY_CHART_MARGIN,
  AXIS_LINE_STROKE as AXIS_STROKE,
} from "./chartLayout";

function formatYmEs(ym: string): string {
  const [ys, ms] = ym.split("-");
  const m = Number(ms);
  const names = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];
  const label = m >= 1 && m <= 12 ? names[m - 1] : ym;
  return `${label} ${ys}`;
}

function unifiedMinMax(points: CcHistorialChartRow[]) {
  let maxV = 0;
  for (const row of points) {
    for (const v of [
      row.installment_payments_clp,
      row.facturado_clp,
      row.cupo_en_cuotas_clp,
      row.balance_total_clp,
    ]) {
      if (typeof v === "number" && Number.isFinite(v)) {
        maxV = Math.max(maxV, v);
      }
    }
  }
  // Credit-card balances are debts (≥ 0); a rare negative month is an artifact, so floor the axis at
  // 0 instead of expanding it below zero for a single outlier.
  return { min: 0, max: Math.max(maxV, 1) };
}

const FACTURADO_FILL = "#d97706";
const CUPO_STROKE = "#f472b6";
const BALANCE_TOTAL_STROKE = "#38bdf8";

const CURRENT_MONTH_STROKE = "#94a3b8";

export function CcInstallmentHistoryChart({
  rows,
  openBillingMonth,
}: {
  rows: CcHistorialChartRow[];
  openBillingMonth?: string | null;
}) {
  const { t } = useTranslation();
  const currentYm = chileTodayYmd().slice(0, 7);
  const refMonth = openBillingMonth ?? currentYm;
  const showCurrentMonthLine = rows.some((r) => r.month === refMonth);
  const yScale = useMemo(() => {
    const { min, max } = unifiedMinMax(rows);
    return buildNiceYAxis(min, max);
  }, [rows]);

  if (rows.length === 0) {
    return <p className="muted empty">Sin historial de cuotas para esta cuenta.</p>;
  }

  return (
    <div className="chart-box line-chart-focus-wrap" style={{ height: 280, marginTop: "0.35rem" }}>
        <AppComposedChart
          data={rows}
          margin={{ ...RECHARTS_MONEY_CHART_MARGIN, left: 4, right: 8, bottom: 4 }}
          tooltip={{
            formatValue: (v) => formatClp(v),
            renderContent: ({ label, payload }) => {
              const d = payload[0]?.payload as CcHistorialChartRow | undefined;
              if (!d) return null;
              return (
                <div style={{ fontSize: 12 }}>
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
            },
            cursor: true,
          }}
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
          <Legend
            wrapperStyle={{ fontSize: 12, color: "var(--muted, #94a3b8)", paddingTop: 6 }}
            formatter={(value) => <span style={{ color: "var(--muted, #94a3b8)" }}>{value}</span>}
          />
          {showCurrentMonthLine ? (
            <ReferenceLine
              x={refMonth}
              stroke={CURRENT_MONTH_STROKE}
              strokeDasharray="4 4"
              strokeWidth={1.5}
              label={{
                value: t(
                  openBillingMonth
                    ? "accountDetail.creditCard.historialOpenMonth"
                    : "accountDetail.creditCard.historialCurrentMonth"
                ),
                position: "insideTopRight",
                fill: CURRENT_MONTH_STROKE,
                fontSize: 10,
              }}
            />
          ) : null}
          <Bar
            dataKey="facturado_clp"
            name={t("accountDetail.creditCard.chartFacturadoClose")}
            fill={FACTURADO_FILL}
            maxBarSize={32}
            radius={[2, 2, 0, 0]}
          />
          <Bar
            dataKey="installment_payments_clp"
            name="Pagos de cuotas (mes)"
            fill="#64748b"
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
        </AppComposedChart>
    </div>
  );
}
