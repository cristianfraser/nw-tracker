import { useMemo } from "react";
import { useTranslation } from "../../i18n";
import { formatFlowMoney } from "../../flowsDisplay";
import type { DisplayUnit } from "../../queries/keys";
import type { FlowWorkEarningRow, PayrollEarningType } from "../../types";
import { workEarningLiquidoDisplayAmount } from "../../incomeAggregates";
import { usePatchWorkEarningMutation } from "../../queries/mutations";
import { PaginatedTable, useClientPagination } from "../ui/PaginatedTable";
import { Table } from "../ui/Table";

const PAGE_SIZE = 12;

function formatOptionalClp(value: number | null, displayUnit: DisplayUnit): string {
  if (value == null) return "—";
  return formatFlowMoney(value, displayUnit);
}

export function WorkEarningsTable({
  rows,
  displayUnit = "clp",
}: {
  rows: readonly FlowWorkEarningRow[];
  displayUnit?: DisplayUnit;
}) {
  const { t } = useTranslation();
  const patchWorkEarning = usePatchWorkEarningMutation();

  const sortedRows = useMemo(
    () => [...rows].sort((a, b) => b.period_month.localeCompare(a.period_month)),
    [rows]
  );

  const { page, setPage, pageRows, total } = useClientPagination(sortedRows, PAGE_SIZE);

  if (rows.length === 0) {
    return <p className="muted">{t("workEarnings.empty")}</p>;
  }

  return (
    <PaginatedTable page={page} pageSize={PAGE_SIZE} total={total} onPageChange={setPage}>
      <Table
        tableStyle={{ fontSize: "0.85rem" }}
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
      >
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
      </Table>
    </PaginatedTable>
  );
}
