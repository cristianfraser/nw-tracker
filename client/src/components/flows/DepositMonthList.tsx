import { Link } from "react-router-dom";
import { cn } from "../../cn";
import { formatFlowMoney } from "../../flowsDisplay";
import { useTranslation } from "../../i18n";
import type { FlowsDepositsResponse } from "../../types";
import type { DisplayUnit } from "../../queries/keys";
import { FlowMonthList, MonthRowDay } from "./FlowMonthList";
import styles from "./FlowMonthRows.module.css";

type CategoryBlock = FlowsDepositsResponse["by_category"][keyof FlowsDepositsResponse["by_category"]];

/**
 * One deposit category as the /flows/deposits page lists it: the server's months, newest first,
 * each under a heading with its total, a row per deposit (day, account, amount). One rendering at
 * every width: the account cell wraps (with its mortgage-carrying tag) instead of the row.
 */
export function DepositMonthList({
  block,
  displayUnit,
  loading,
}: {
  block: CategoryBlock | null;
  displayUnit: DisplayUnit;
  loading: boolean;
}) {
  const { t } = useTranslation();
  return (
    <FlowMonthList
      months={block?.months ?? []}
      loading={loading}
      emptyLabel={t("deposits.emptyCategory")}
      monthTotal={(m) => formatFlowMoney(m.total, displayUnit)}
      rowKey={(r, idx) => `${r.account_id}-${r.occurred_on}-${idx}`}
      renderRow={(r) => (
        <>
          <MonthRowDay ymd={r.occurred_on} />
          <span className={styles.account}>
            <Link to={`/account/${r.account_id}`}>{r.account_name}</Link>
            {r.mortgage_carrying ? <span className={styles.chip}>{t("deposits.mortgageCarryingTag")}</span> : null}
          </span>
          <span className={cn("mono", styles.num)}>{formatFlowMoney(r.amount, displayUnit)}</span>
        </>
      )}
    />
  );
}
