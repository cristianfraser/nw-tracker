import { useState } from "react";
import { Link } from "react-router-dom";
import { useTranslation } from "../../i18n";
import { formatFlowMoney } from "../../flowsDisplay";
import type { DisplayUnit } from "../../queries/keys";
import type { FlowExcludedCheckingIncomeLine } from "../../types";
import { useRestoreIncomeMovementMutation } from "../../queries/mutations";
import { ConfirmDialog } from "../ui/ConfirmDialog";

function excludedLineAmount(line: FlowExcludedCheckingIncomeLine, unit: DisplayUnit): number {
  if (unit === "usd") {
    if (line.amount_usd == null) {
      throw new Error(`missing amount_usd for excluded income movement ${line.movement_id}`);
    }
    return line.amount_usd;
  }
  return Math.round(line.amount_clp);
}

export function IncomeExcludedLinesTable({
  rows,
  displayUnit = "clp",
}: {
  rows: readonly FlowExcludedCheckingIncomeLine[];
  displayUnit?: DisplayUnit;
}) {
  const { t } = useTranslation();
  const restoreIncomeMovement = useRestoreIncomeMovementMutation();
  const [restoreTarget, setRestoreTarget] = useState<{
    movement_id: number;
    description: string;
    received_on: string;
  } | null>(null);

  if (rows.length === 0) {
    return <p className="muted">{t("income.excludedEmpty")}</p>;
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
            <th>{t("income.colNote")}</th>
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
              <td className="muted">{row.note ?? "—"}</td>
              <td>
                <button
                  type="button"
                  className="btn"
                  disabled={restoreIncomeMovement.isPending}
                  onClick={() =>
                    setRestoreTarget({
                      movement_id: row.movement_id,
                      description: row.description,
                      received_on: row.received_on,
                    })
                  }
                >
                  {t("income.restoreLine")}
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <ConfirmDialog
        open={restoreTarget != null}
        title={t("income.restoreConfirmTitle")}
        message={
          restoreTarget
            ? t("income.restoreConfirmMessage", {
                date: restoreTarget.received_on,
                description: restoreTarget.description,
              })
            : ""
        }
        confirmLabel={t("income.restoreConfirmAction")}
        cancelLabel={t("income.restoreConfirmCancel")}
        onCancel={() => setRestoreTarget(null)}
        onConfirm={() => {
          if (!restoreTarget) return;
          restoreIncomeMovement.mutate(restoreTarget.movement_id, {
            onSettled: () => setRestoreTarget(null),
          });
        }}
      />
    </>
  );
}
