import { useMemo } from "react";
import { useTranslation } from "../../i18n";
import { formatFlowMoney } from "../../flowsDisplay";
import type { DisplayUnit } from "../../queries/keys";
import type { FlowWorkEarningRow, PayrollEarningType } from "../../types";
import { workEarningLiquidoDisplayAmount } from "../../incomeAggregates";
import { usePatchWorkEarningMutation } from "../../queries/mutations";
import { PaginatedTable } from "../ui/PaginatedTable";

function formatOptionalClp(value: number | null, displayUnit: DisplayUnit): string {
  if (value == null) return "—";
  return formatFlowMoney(value, displayUnit);
}

export function WorkEarningsTable({
  rows,
  collapsedVisibleRows = 12,
  displayUnit = "clp",
}: {
  rows: readonly FlowWorkEarningRow[];
  collapsedVisibleRows?: number;
  displayUnit?: DisplayUnit;
}) {
  const { t } = useTranslation();
  const patchWorkEarning = usePatchWorkEarningMutation();

  const pages = useMemo(() => {
    const byYear = new Map<string, FlowWorkEarningRow[]>();
    for (const row of rows) {
      const year = row.period_month.slice(0, 4);
      const bucket = byYear.get(year) ?? [];
      bucket.push(row);
      byYear.set(year, bucket);
    }
    return [...byYear.keys()]
      .sort((a, b) => Number(a) - Number(b))
      .map((year, pageNumber) => ({ pageNumber, data: byYear.get(year) ?? [] }));
  }, [rows]);

  if (rows.length === 0) {
    return <p className="muted">{t("workEarnings.empty")}</p>;
  }

  return (
    <PaginatedTable
      pages={pages}
      collapsedVisibleRows={collapsedVisibleRows}
      showMoreLabel={(hiddenCount) => t("table.showMoreLines", { count: hiddenCount })}
      showLessLabel={t("table.showLess")}
      tableStyle={{ fontSize: "0.85rem" }}
      getPageLabel={(page) => page.data[0]?.period_month.slice(0, 4) ?? String(page.pageNumber)}
      header={
        <thead>
          <tr>
            <th>{t("workEarnings.colPeriod")}</th>
            <th>{t("workEarnings.colEmployer")}</th>
            <th>{t("workEarnings.colBase")}</th>
            <th>{t("workEarnings.colGratificacion")}</th>
            <th>{t("workEarnings.colColacion")}</th>
            <th>{t("workEarnings.colMovilizacion")}</th>
            <th>{t("workEarnings.colBruto")}</th>
            <th>{t("workEarnings.colDescuentos")}</th>
            <th>{t("workEarnings.colLiquido")}</th>
            <th>{t("workEarnings.colType")}</th>
            <th>{t("workEarnings.colInflow")}</th>
          </tr>
        </thead>
      }
      renderBody={(pageRows) => (
        <>
          {pageRows.map((row) => (
            <tr key={row.id}>
              <td className="mono">{row.period_month}</td>
              <td title={row.employer_rut ?? undefined}>{row.employer_name}</td>
              <td className="mono">{formatOptionalClp(row.base_salary_clp, displayUnit)}</td>
              <td className="mono muted">{formatOptionalClp(row.gratificacion_clp, displayUnit)}</td>
              <td className="mono muted">{formatOptionalClp(row.colacion_clp, displayUnit)}</td>
              <td className="mono muted">{formatOptionalClp(row.movilizacion_clp, displayUnit)}</td>
              <td className="mono">{formatOptionalClp(row.total_haberes_clp, displayUnit)}</td>
              <td className="mono muted">{formatOptionalClp(row.total_descuentos_clp, displayUnit)}</td>
              <td className="mono">{formatFlowMoney(workEarningLiquidoDisplayAmount(row, displayUnit), displayUnit)}</td>
              <td>
                <select
                  value={row.earning_type}
                  disabled={patchWorkEarning.isPending}
                  onChange={(e) => {
                    const earning_type = e.target.value as PayrollEarningType;
                    patchWorkEarning.mutate({ id: row.id, earning_type });
                  }}
                  aria-label={t("workEarnings.colType")}
                >
                  <option value="salary">{t("income.chart.salary")}</option>
                  <option value="severance">{t("income.chart.severance")}</option>
                </select>
              </td>
              <td>
                {row.movement_id != null && row.linked_received_on ? (
                  <span className="mono">
                    {row.linked_received_on}{" "}
                    {formatFlowMoney(row.linked_amount_clp ?? row.liquido_clp, displayUnit)}
                    {row.link_source ? (
                      <span className="muted" style={{ marginLeft: "0.35rem" }}>
                        ({t(`workEarnings.linkSource.${row.link_source}`)})
                      </span>
                    ) : null}
                  </span>
                ) : row.wire_received_on ? (
                  <span className="mono">
                    {row.wire_received_on}
                    <span className="muted" style={{ marginLeft: "0.35rem" }}>
                      ({t("workEarnings.usdWire")})
                    </span>
                  </span>
                ) : (
                  <span className="muted">{t("workEarnings.unlinked")}</span>
                )}
              </td>
            </tr>
          ))}
        </>
      )}
    />
  );
}
