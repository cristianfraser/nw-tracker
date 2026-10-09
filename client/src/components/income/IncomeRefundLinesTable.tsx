import { TransferCounterpartyLine } from "../flows/TransferCounterpartyLine";
import { Link } from "react-router-dom";
import { Button } from "@crfrsr/ui";
import { ccExpenseCategoryLabel, useTranslation } from "../../i18n";
import { formatFlowMoney } from "../../flowsDisplay";
import { incomeCartolaAmount } from "../../incomeAggregates";
import type { DisplayUnit } from "../../queries/keys";
import type { FlowCheckingIncomeLine } from "../../types";
import { useIncomeRefundMutation } from "../../queries/mutations";
import { loadableClass } from "../ui/Loadable";

/**
 * Credits marked as refunds of spending (someone paying back a shared expense, an additional
 * cardholder paying back his charges). They are not income: each is a negative line in its expense
 * category, which the Expenses page sets. «Back to income» undoes the mark.
 */
export function IncomeRefundLinesTable({
  rows,
  displayUnit = "clp",
  loading,
}: {
  rows: readonly (FlowCheckingIncomeLine & { category_slug: string })[];
  displayUnit?: DisplayUnit;
  loading?: boolean;
}) {
  const { t } = useTranslation();
  const incomeRefund = useIncomeRefundMutation();

  if (rows.length === 0 && !loading) {
    return <p className="muted">{t("income.refundsEmpty")}</p>;
  }

  return (
    <table className={loadableClass(loading, "data-table")} style={{ fontSize: "0.85rem" }}>
      <thead>
        <tr>
          <th>{t("income.colDate")}</th>
          <th>{t("income.colAmount")}</th>
          <th>{t("income.colDescription")}</th>
          <th>{t("income.colAccount")}</th>
          <th>{t("income.colRefundCategory")}</th>
          <th />
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={row.movement_id}>
            <td className="mono">{row.received_on}</td>
            <td className="mono">{formatFlowMoney(incomeCartolaAmount(row, displayUnit), displayUnit)}</td>
            <td>
              {row.description}
              <TransferCounterpartyLine counterparty={row.transfer_counterparty} />
            </td>
            <td>
              <Link to={`/account/${row.account_id}`}>{row.account_label}</Link>
            </td>
            <td>{ccExpenseCategoryLabel(row.category_slug)}</td>
            <td>
              <Button
                variant="secondary"
                disabled={incomeRefund.isPending}
                onClick={() => incomeRefund.mutate({ movement_id: row.movement_id, refund: false })}
              >
                {t("income.backToIncome")}
              </Button>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
