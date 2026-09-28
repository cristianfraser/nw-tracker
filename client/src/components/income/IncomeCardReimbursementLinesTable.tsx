import { Link } from "react-router-dom";
import { useTranslation } from "../../i18n";
import { formatFlowMoney } from "../../flowsDisplay";
import { incomeCartolaAmount } from "../../incomeAggregates";
import type { DisplayUnit } from "../../queries/keys";
import type { FlowCheckingIncomeLine, IncomeKind } from "../../types";
import { usePatchIncomeMovementMutation } from "../../queries/mutations";

/**
 * Credits classified as additional-card reimbursements. They are not income (the server keeps
 * them out of the income lines); the type select moves one back into income.
 */
export function IncomeCardReimbursementLinesTable({
  rows,
  displayUnit = "clp",
}: {
  rows: readonly FlowCheckingIncomeLine[];
  displayUnit?: DisplayUnit;
}) {
  const { t } = useTranslation();
  const patchIncomeMovement = usePatchIncomeMovementMutation();

  if (rows.length === 0) {
    return <p className="muted">{t("income.cardReimbursementsEmpty")}</p>;
  }

  return (
    <table className="data-table" style={{ fontSize: "0.85rem" }}>
      <thead>
        <tr>
          <th>{t("income.colDate")}</th>
          <th>{t("income.colAmount")}</th>
          <th>{t("income.colDescription")}</th>
          <th>{t("income.colAccount")}</th>
          <th>{t("income.colIncomeKind")}</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={row.movement_id}>
            <td className="mono">{row.received_on}</td>
            <td className="mono">
              {formatFlowMoney(incomeCartolaAmount(row, displayUnit), displayUnit)}
            </td>
            <td>{row.description}</td>
            <td>
              <Link to={`/account/${row.account_id}`}>{row.account_label}</Link>
            </td>
            <td>
              <select
                value="card_reimbursement"
                disabled={patchIncomeMovement.isPending}
                onChange={(e) => {
                  patchIncomeMovement.mutate({
                    movement_id: row.movement_id,
                    income_kind: e.target.value as IncomeKind,
                  });
                }}
                aria-label={t("income.colIncomeKind")}
              >
                <option value="card_reimbursement">{t("income.chart.card_reimbursement")}</option>
                <option value="salary">{t("income.chart.salary")}</option>
                <option value="severance">{t("income.chart.severance")}</option>
                <option value="parent_gift">{t("income.chart.parent_gift")}</option>
                <option value="other">{t("income.chart.other")}</option>
              </select>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
