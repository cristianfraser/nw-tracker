import { useState } from "react";
import { Link } from "react-router-dom";
import { Button } from "@crfrsr/ui";
import { cn } from "../../cn";
import { formatFlowMoney } from "../../flowsDisplay";
import { formatYearMonthLabel } from "../../formatDateLabel";
import { useTranslation } from "../../i18n";
import { loadableClass } from "../ui/Loadable";
import type { FlowsDepositsResponse } from "../../types";
import type { DisplayUnit } from "../../queries/keys";
import styles from "./FlowMonthRows.module.css";

type CategoryBlock = FlowsDepositsResponse["by_category"][keyof FlowsDepositsResponse["by_category"]];

/** Rows shown before «show more»: whole months, until at least this many rows. */
const COLLAPSED_ROWS = 15;

/** How many of the newest months make up the collapsed list. */
function collapsedMonthCount(months: CategoryBlock["months"]): number {
  let rows = 0;
  for (let i = 0; i < months.length; i++) {
    rows += months[i]!.rows.length;
    if (rows >= COLLAPSED_ROWS) return i + 1;
  }
  return months.length;
}

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
  const [expanded, setExpanded] = useState(false);
  const months = block?.months ?? [];
  const collapsedCount = collapsedMonthCount(months);
  const shown = expanded ? months : months.slice(0, collapsedCount);
  return (
    <div className={loadableClass(loading, styles.frame)}>
      {months.length === 0 && !loading ? (
        <p className="muted">{t("deposits.emptyCategory")}</p>
      ) : (
        <div className={cn(styles.list, styles.deposits)} role="list">
          {shown.map((m) => (
            <div key={m.month} role="listitem" style={{ display: "contents" }}>
              <div className={styles.month}>
                <span>{formatYearMonthLabel(m.month)}</span>
                <span className="mono">{formatFlowMoney(m.total, displayUnit)}</span>
              </div>
              {m.rows.map((r, idx) => (
                <div key={`${r.account_id}-${r.occurred_on}-${idx}`} className={styles.row}>
                  <span className={cn("mono", styles.day)} title={r.occurred_on}>
                    {r.occurred_on.slice(8, 10)}
                  </span>
                  <span className={styles.account}>
                    <Link to={`/account/${r.account_id}`}>{r.account_name}</Link>
                    {r.mortgage_carrying ? (
                      <span className={styles.chip}>{t("deposits.mortgageCarryingTag")}</span>
                    ) : null}
                  </span>
                  <span className={cn("mono", styles.num)}>{formatFlowMoney(r.amount, displayUnit)}</span>
                </div>
              ))}
            </div>
          ))}
        </div>
      )}
      {collapsedCount < months.length ? (
        <Button variant="ghost" className={styles.more} onClick={() => setExpanded((e) => !e)}>
          {expanded ? t("table.showLess") : t("notifications.showMore")}
        </Button>
      ) : null}
    </div>
  );
}
