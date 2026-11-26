import { useId, useState, type ReactNode } from "react";
import { Button } from "@crfrsr/ui";
import { cn } from "../../cn";
import { formatYearMonthLabel } from "../../formatDateLabel";
import { useTranslation } from "../../i18n";
import { loadableClass } from "../ui/Loadable";
import styles from "./FlowMonthRows.module.css";

/** A calendar month of a list as the server sends it: newest first, with its total. */
export type FlowMonth<R> = { month: string; rows: R[] };

/** Rows shown before «show more»: whole months, until at least this many rows. */
const COLLAPSED_ROWS = 15;

/** How many of the newest months make up the collapsed list. */
function collapsedMonthCount(months: readonly FlowMonth<unknown>[]): number {
  let rows = 0;
  for (let i = 0; i < months.length; i++) {
    rows += months[i]!.rows.length;
    if (rows >= COLLAPSED_ROWS) return i + 1;
  }
  return months.length;
}

/** A row's day: the day of the month drawn, the full date for a screen reader and on hover. */
export function MonthRowDay({ ymd }: { ymd: string }) {
  return (
    <span className={cn("mono", styles.day)} title={ymd}>
      <span aria-hidden="true">{ymd.slice(8, 10)}</span>
      <span className="visually-hidden">{ymd}</span>
    </span>
  );
}

/**
 * The flows pages' list by month (the /flows/deposits list): the server's months, newest first,
 * each under a heading with its total, its rows a list on the list's three columns (day, what,
 * amount). One rendering at every width: the middle cell wraps instead of the row. Whole months
 * until 15 rows, then «show more».
 */
export function FlowMonthList<M extends FlowMonth<unknown>>({
  months,
  loading,
  emptyLabel,
  monthHeading: MonthHeading = "h4",
  monthTotal,
  rowKey,
  renderRow,
}: {
  months: readonly M[];
  loading: boolean;
  /** Said in place of the list once it has loaded with no months. */
  emptyLabel?: string;
  /** The month headings' level: one below the heading the list sits under. */
  monthHeading?: "h4" | "h5";
  /** The month's total, formatted. */
  monthTotal: (month: M) => string;
  rowKey: (row: M["rows"][number], index: number) => string | number;
  /** The row's cells: a day (or a cell spanning it), what the row is, its amount. */
  renderRow: (row: M["rows"][number]) => ReactNode;
}) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const idBase = useId();
  const collapsedCount = collapsedMonthCount(months);
  const shown = expanded ? months : months.slice(0, collapsedCount);
  return (
    <div className={loadableClass(loading, styles.frame)}>
      {months.length === 0 ? (
        !loading && emptyLabel ? (
          <p className="muted">{emptyLabel}</p>
        ) : null
      ) : (
        <div className={cn(styles.list, styles.deposits)}>
          {shown.map((m) => (
            <section key={m.month} className={styles.monthGroup} aria-labelledby={`${idBase}-${m.month}`}>
              <MonthHeading id={`${idBase}-${m.month}`} className={styles.month}>
                <span>{formatYearMonthLabel(m.month)}</span>
                <span className="mono">{monthTotal(m)}</span>
              </MonthHeading>
              <div role="list" className={styles.monthRows}>
                {m.rows.map((r, idx) => (
                  <div key={rowKey(r, idx)} role="listitem" className={styles.row}>
                    {renderRow(r)}
                  </div>
                ))}
              </div>
            </section>
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
