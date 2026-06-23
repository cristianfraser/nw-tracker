import { useState } from "react";
import { Link } from "react-router-dom";
import { useTranslation } from "../../i18n";
import { formatFlowMoney } from "../../flowsDisplay";
import type { DisplayUnit } from "../../queries/keys";
import type { FlowFilteredCheckingIncomeLine, IncomeAutoFilterReason } from "../../types";
import { useForceIncludeIncomeMovementMutation } from "../../queries/mutations";
import { ConfirmDialog } from "../ui/ConfirmDialog";

function excludedLineAmount(line: FlowFilteredCheckingIncomeLine, unit: DisplayUnit): number {
  if (unit === "usd") {
    if (line.amount_usd == null) {
      throw new Error(`missing amount_usd for filtered income movement ${line.movement_id}`);
    }
    return line.amount_usd;
  }
  return Math.round(line.amount_clp);
}

function filterReasonLabel(
  t: (key: string) => string,
  reason: IncomeAutoFilterReason
): string {
  return t(`income.filterReason.${reason}`);
}

export function IncomeFilteredLinesTable({
  rows,
  displayUnit = "clp",
}: {
  rows: readonly FlowFilteredCheckingIncomeLine[];
  displayUnit?: DisplayUnit;
}) {
  const { t } = useTranslation();
  const forceInclude = useForceIncludeIncomeMovementMutation();
  const [includeTarget, setIncludeTarget] = useState<{
    movement_id: number;
    description: string;
    received_on: string;
  } | null>(null);

  if (rows.length === 0) {
    return <p className="muted">{t("income.filteredEmpty")}</p>;
  }

  return (
    <>
      <table className="data-table" style={{ fontSize: "0.85rem" }}>
        <thead>
          <tr>
            <th>{t("income.colDate")}</th>
            <th>{t("income.colAmount")}</th>
            <th>{t("income.colDescription")}</th>
            <th>{t("income.colAccount")}</th>
            <th>{t("income.colFilterReason")}</th>
            <th>{t("income.colActions")}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.movement_id}>
              <td className="mono">{row.received_on}</td>
              <td className="mono">
                {formatFlowMoney(excludedLineAmount(row, displayUnit), displayUnit)}
              </td>
              <td>{row.description}</td>
              <td>
                <Link to={`/account/${row.account_id}`}>{row.account_label}</Link>
              </td>
              <td className="muted">{filterReasonLabel(t, row.filter_reason)}</td>
              <td>
                <button
                  type="button"
                  className="btn"
                  disabled={forceInclude.isPending}
                  onClick={() =>
                    setIncludeTarget({
                      movement_id: row.movement_id,
                      description: row.description,
                      received_on: row.received_on,
                    })
                  }
                >
                  {t("income.includeLine")}
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <ConfirmDialog
        open={includeTarget != null}
        title={t("income.includeConfirmTitle")}
        message={
          includeTarget
            ? t("income.includeConfirmMessage", {
                date: includeTarget.received_on,
                description: includeTarget.description,
              })
            : ""
        }
        confirmLabel={t("income.includeConfirmAction")}
        cancelLabel={t("income.includeConfirmCancel")}
        onCancel={() => setIncludeTarget(null)}
        onConfirm={() => {
          if (!includeTarget) return;
          forceInclude.mutate(includeTarget.movement_id, {
            onSettled: () => setIncludeTarget(null),
          });
        }}
      />
    </>
  );
}
