import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useTranslation } from "../../i18n";
import { formatFlowMoney } from "../../flowsDisplay";
import type { DisplayUnit } from "../../queries/keys";
import type { IncomeKind } from "../../types";
import type { IncomeDisplayRow } from "../../incomeAggregates";
import {
  incomeCartolaAmount,
  incomeKindLabel,
  incomeManualAmount,
  paginateRowsByYear,
} from "../../incomeAggregates";
import { usePatchIncomeMovementMutation } from "../../queries/mutations";
import { ConfirmDialog } from "../ui/ConfirmDialog";
import { PaginatedTable } from "../ui/PaginatedTable";

export function IncomeAllLinesTable({
  rows,
  collapsedVisibleRows = 15,
  displayUnit = "clp",
}: {
  rows: readonly IncomeDisplayRow[];
  collapsedVisibleRows?: number;
  displayUnit?: DisplayUnit;
}) {
  const { t } = useTranslation();
  const patchIncomeMovement = usePatchIncomeMovementMutation();
  const [excludeTarget, setExcludeTarget] = useState<{
    movement_id: number;
    description: string;
    received_on: string;
  } | null>(null);

  const pages = useMemo(() => paginateRowsByYear(rows), [rows]);

  if (rows.length === 0) {
    return (
      <p className="muted">
        {t("income.empty")} <span className="mono">{t("income.manualApiHint")}</span>
      </p>
    );
  }

  return (
    <>
      <PaginatedTable
        pages={pages}
        collapsedVisibleRows={collapsedVisibleRows}
        showMoreLabel={(hiddenCount) => t("table.showMoreLines", { count: hiddenCount })}
        showLessLabel={t("table.showLess")}
        tableStyle={{ fontSize: "0.85rem" }}
        getPageLabel={(page) => page.data[0]?.received_on.slice(0, 4) ?? String(page.pageNumber)}
        header={
          <thead>
            <tr>
              <th>{t("income.colDate")}</th>
              <th>{t("income.colAmount")}</th>
              <th>{t("income.colDescription")}</th>
              <th>{t("income.colAccount")}</th>
              <th>{t("income.colIncomeKind")}</th>
              <th>{t("income.colOrigin")}</th>
              <th>{t("income.colActions")}</th>
            </tr>
          </thead>
        }
        renderBody={(pageRows) => (
          <>
            {pageRows.map((row) => {
              if (row.kind === "checking") {
                return (
                  <tr key={`checking-${row.movement_id}`}>
                    <td className="mono">
                      {row.received_on}
                      {row.payroll_period_month ? (
                        <span className="muted">
                          {" "}
                          ({t("income.colPayrollPeriod", { month: row.payroll_period_month })})
                        </span>
                      ) : null}
                    </td>
                    <td className="mono">
                      {formatFlowMoney(incomeCartolaAmount(row, displayUnit), displayUnit)}
                    </td>
                    <td>{row.description}</td>
                    <td>
                      <Link to={`/account/${row.account_id}`}>{row.account_label}</Link>
                    </td>
                    <td>
                      <select
                        value={row.income_kind}
                        disabled={patchIncomeMovement.isPending}
                        onChange={(e) => {
                          const income_kind = e.target.value as IncomeKind;
                          patchIncomeMovement.mutate({
                            movement_id: row.movement_id,
                            income_kind,
                          });
                        }}
                        aria-label={t("income.colIncomeKind")}
                      >
                        <option value="salary">{t("income.chart.salary")}</option>
                        <option value="severance">{t("income.chart.severance")}</option>
                        <option value="parent_gift">{t("income.chart.parent_gift")}</option>
                        <option value="other">{t("income.chart.other")}</option>
                      </select>
                    </td>
                    <td>{t("income.originChecking")}</td>
                    <td>
                      <button
                        type="button"
                        className="btn"
                        disabled={patchIncomeMovement.isPending}
                        onClick={() =>
                          setExcludeTarget({
                            movement_id: row.movement_id,
                            description: row.description,
                            received_on: row.received_on,
                          })
                        }
                      >
                        {t("income.excludeLine")}
                      </button>
                    </td>
                  </tr>
                );
              }
              return (
                <tr key={`manual-${row.id}`}>
                  <td className="mono">{row.received_on}</td>
                  <td className="mono">
                    {formatFlowMoney(incomeManualAmount(row, displayUnit), displayUnit)}
                  </td>
                  <td>{row.source ?? "—"}</td>
                  <td className="muted">{row.note ?? "—"}</td>
                  <td>{incomeKindLabel(t, row.income_kind)}</td>
                  <td>{t("income.originManual")}</td>
                  <td />
                </tr>
              );
            })}
          </>
        )}
      />

      <ConfirmDialog
        open={excludeTarget != null}
        title={t("income.excludeConfirmTitle")}
        message={
          excludeTarget
            ? t("income.excludeConfirmMessage", {
                date: excludeTarget.received_on,
                description: excludeTarget.description,
              })
            : ""
        }
        confirmLabel={t("income.excludeConfirmAction")}
        cancelLabel={t("income.excludeConfirmCancel")}
        confirmDisabled={patchIncomeMovement.isPending}
        onCancel={() => setExcludeTarget(null)}
        onConfirm={() => {
          if (!excludeTarget) return;
          patchIncomeMovement.mutate(
            { movement_id: excludeTarget.movement_id, excluded: true },
            { onSuccess: () => setExcludeTarget(null) }
          );
        }}
      />
    </>
  );
}
