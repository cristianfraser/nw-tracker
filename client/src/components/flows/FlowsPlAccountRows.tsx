import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { cn } from "../../cn";
import { formatFlowMoney } from "../../flowsDisplay";
import { useTranslation } from "../../i18n";
import { loadableClass } from "../ui/Loadable";
import type { FlowsPlResponse } from "../../types";
import type { DisplayUnit } from "../../queries/keys";
import styles from "./FlowMonthRows.module.css";

type Bucket = FlowsPlResponse["by_bucket"][number];

/**
 * One bucket's accounts on /flows/pl: account, this month's P/L, YTD, cumulative, and the bucket
 * total last. Wide, one line per account in columns; narrow (container query), the account and its
 * cumulative on the first line, «month … · YTD …» under them. Every figure carries its label for
 * screen readers (the header row is visual only): wide, the inline labels are visually hidden.
 */
export function FlowsPlAccountRows({
  block,
  displayUnit,
  loading,
}: {
  block: Bucket;
  displayUnit: DisplayUnit;
  loading: boolean;
}) {
  const { t } = useTranslation();
  const monthLabel = t("flows.pl.colMonthPl");
  const ytdLabel = t("flows.pl.colYtd");
  const cumulativeLabel = t("flows.pl.colCumulative");
  const row = (
    key: string | number,
    name: ReactNode,
    month: number,
    ytd: number,
    cumulative: number,
    total = false
  ) => (
    <div key={key} role="listitem" className={styles.row}>
      <span className={cn(styles.plName, total && styles.strong)}>{name}</span>
      <span className={styles.plMeta}>
        <span className={styles.num}>
          <span className={styles.plMetaLabel}>{monthLabel}</span>
          <span className={cn("mono", styles.plMetaValue, total && styles.strong)}>
            {formatFlowMoney(month, displayUnit)}
          </span>
        </span>
        <span className={styles.num}>
          <span className={styles.plMetaLabel}>{ytdLabel}</span>
          <span className={cn("mono", styles.plMetaValue, total && styles.strong)}>
            {formatFlowMoney(ytd, displayUnit)}
          </span>
        </span>
      </span>
      <span className={cn("mono", styles.num, styles.plCum, total && styles.strong)}>
        <span className="visually-hidden">{cumulativeLabel} </span>
        {formatFlowMoney(cumulative, displayUnit)}
      </span>
    </div>
  );
  return (
    <div className={loadableClass(loading, styles.frame)}>
      <div className={cn(styles.list, styles.pl)} role="list">
        <div className={cn(styles.row, styles.head)} aria-hidden="true">
          <span className={styles.plName}>{t("flows.pl.colAccount")}</span>
          <span className={styles.plMeta}>
            <span className={cn(styles.num, styles.plMetaHead)}>{monthLabel}</span>
            <span className={cn(styles.num, styles.plMetaHead)}>{ytdLabel}</span>
          </span>
          <span className={cn(styles.num, styles.plCum)}>{cumulativeLabel}</span>
        </div>
        {block.accounts.map((a) =>
          row(
            a.account_id,
            <Link to={`/account/${a.account_id}`}>{a.name}</Link>,
            a.pl_month,
            a.pl_ytd,
            a.pl_cumulative
          )
        )}
        {row(
          "total",
          t("flows.pl.totalsLabel"),
          block.total_month,
          block.total_ytd,
          block.total_cumulative,
          true
        )}
      </div>
    </div>
  );
}
