import { Fragment, useMemo, useState, type KeyboardEvent, type ReactNode } from "react";
import { cn } from "../../cn";
import { flowPeriodLabel, formatFlowMoney } from "../../flowsDisplay";
import { rollupFlowsPlChartPointsByYear } from "../../flowsPlAggregate";
import { flowsPlBucketLabel, useTranslation } from "../../i18n";
import type { DisplayUnit } from "../../queries/keys";
import type { FlowsPlChartPoint } from "../../types";
import { ChevronIcon } from "../ui/ChevronIcon";
import { PaginatedTable, useClientPagination } from "../ui/PaginatedTable";
import rows from "../income/IncomeRows.module.css";
import { FLOWS_PL_BUCKET_SERIES, FLOWS_PL_TOTAL_COLOR } from "./flowsPlBuckets";
import styles from "./FlowPeriodRows.module.css";
import { ZeroBar, zeroBarExtent, zeroBarSides } from "./ZeroBar";

const PAGE_SIZE = 12;

function onKeyActivate(e: KeyboardEvent, run: () => void) {
  if (e.key === "Enter" || e.key === " ") {
    e.preventDefault();
    run();
  }
}

/** A period's P/L by bucket around zero: gains to the right, losses to the left. */
function barSides(row: FlowsPlChartPoint) {
  return zeroBarSides(FLOWS_PL_BUCKET_SERIES.map((b) => ({ key: b.slug, color: b.color, value: row[b.slug] })));
}

/**
 * The /flows P/L page's period list, on the flows overview's rows: one row per month (or per year,
 * which opens into its figures and its months) with the period's P/L by bucket as a bar around
 * zero (the «P/L by bucket» chart's bars and colours, its total line a mark), each bucket's amount
 * the total and, quieter, the cumulative total. A period opens into its buckets adding up to the total, and its running totals.
 * Rows are the server's (`chart_monthly`); a year is `rollupFlowsPlChartPointsByYear`. Full
 * history, newest first.
 */
export function FlowsPlPeriodList({
  months,
  granularity,
  displayUnit,
  loading,
}: {
  /** The server's month points, oldest first; null until the payload arrives. */
  months: readonly FlowsPlChartPoint[] | null;
  granularity: "month" | "year";
  displayUnit: DisplayUnit;
  loading?: boolean;
}) {
  const { t } = useTranslation();
  const [openKeys, setOpenKeys] = useState<ReadonlySet<string>>(new Set());

  const periodRows = useMemo(() => {
    if (!months) return [];
    return [...(granularity === "year" ? rollupFlowsPlChartPointsByYear(months) : months)].reverse();
  }, [months, granularity]);
  const { page, setPage, pageRows, total } = useClientPagination(periodRows, PAGE_SIZE);

  if (periodRows.length === 0 && !loading) {
    return <p className="muted">{t("flows.pl.chartEmpty")}</p>;
  }

  const money = (v: number) => formatFlowMoney(v, displayUnit);
  const toggle = (key: string) =>
    setOpenKeys((prev) => {
      const next = new Set(prev);
      if (!next.delete(key)) next.add(key);
      return next;
    });
  const scaleOf = (list: readonly FlowsPlChartPoint[]) =>
    Math.max(0, ...list.map((r) => zeroBarExtent(barSides(r), r.total)));

  function sums(row: FlowsPlChartPoint, grain: "month" | "year"): ReactNode {
    return (
      <div className={styles.sums}>
        <div className={rows.pairs}>
          <span className={rows.pairsHead}>{t("flows.pl.groupBuckets")}</span>
          {FLOWS_PL_BUCKET_SERIES.map((b) => (
            <Fragment key={b.slug}>
              <span>{flowsPlBucketLabel(b.slug)}</span>
              <span className={cn("mono", rows.num)}>{money(row[b.slug])}</span>
            </Fragment>
          ))}
          <span className={cn(rows.pairsTotal, rows.strong)}>{t("flows.pl.colTotal")}</span>
          <span className={cn("mono", rows.num, rows.pairsTotal, rows.strong)}>{money(row.total)}</span>
        </div>
        <div className={rows.pairs}>
          <span className={rows.pairsHead}>{t("flows.pl.groupRunning")}</span>
          {/* A year's own total is its year to date. */}
          {grain === "month" ? (
            <>
              <span>{t("flows.pl.colYtd")}</span>
              <span className={cn("mono", rows.num)}>{money(row.ytd_total)}</span>
            </>
          ) : null}
          <span>{t("flows.pl.colCumulative")}</span>
          <span className={cn("mono", rows.num)}>{money(row.cumulative_total)}</span>
        </div>
      </div>
    );
  }

  function rowsOf(list: readonly FlowsPlChartPoint[], grain: "month" | "year", scale: number): ReactNode {
    return list.map((row) => {
      const key = row.as_of_date.slice(0, grain === "year" ? 4 : 7);
      const open = openKeys.has(key);
      const period = flowPeriodLabel(row.as_of_date, grain);
      // The row's figures carry no labels of their own, so its accessible name says what each is.
      const rowLabel = t("flows.pl.rowLabel", {
        period,
        total: money(row.total),
        cumulative: money(row.cumulative_total),
        parts: FLOWS_PL_BUCKET_SERIES.map((b) => `${flowsPlBucketLabel(b.slug)} ${money(row[b.slug])}`).join(", "),
      });
      const yearMonths =
        open && grain === "year" ? (months ?? []).filter((m) => m.as_of_date.startsWith(key)).reverse() : [];
      return (
        <Fragment key={key}>
          <div
            className={cn(rows.row, rows.opens, open && rows.open)}
            role="button"
            tabIndex={0}
            aria-expanded={open}
            aria-label={rowLabel}
            onClick={() => toggle(key)}
            onKeyDown={(e: KeyboardEvent) => onKeyActivate(e, () => toggle(key))}
          >
            <span className={rows.mPeriod}>{period}</span>
            <ZeroBar
              {...barSides(row)}
              mark={{ value: row.total, color: FLOWS_PL_TOTAL_COLOR }}
              scale={scale}
              className={rows.mBar}
            />
            <span className={cn(rows.parts, rows.mParts, rows.small)}>
              {/* Every bucket on every row, a zero included: the four amounts keep their places. */}
              {FLOWS_PL_BUCKET_SERIES.map((b) => (
                <span key={b.slug} className={rows.nowrap} title={flowsPlBucketLabel(b.slug)}>
                  <i className={rows.dot} style={{ background: b.color }} />
                  <span className="mono">{money(row[b.slug])}</span>
                </span>
              ))}
            </span>
            <span className={cn("mono", rows.num, rows.strong, rows.mTotal)} title={t("flows.pl.colTotal")}>
              {money(row.total)}
            </span>
            {/* The income rows' line-count slot: the running total, quiet, to scan down the list. */}
            <span className={cn("mono muted", rows.num, rows.small, rows.mCount)} title={t("flows.pl.colCumulative")}>
              <span className="visually-hidden">{t("flows.pl.colCumulative")} </span>
              {money(row.cumulative_total)}
            </span>
            <ChevronIcon className={rows.chevron} />
          </div>
          {open ? (
            <div className={rows.sub}>
              {sums(row, grain)}
              {grain === "year" ? (
                <div className={cn(rows.list, rows.months)}>{rowsOf(yearMonths, "month", scaleOf(yearMonths))}</div>
              ) : null}
            </div>
          ) : null}
        </Fragment>
      );
    });
  }

  return (
    <PaginatedTable page={page} pageSize={PAGE_SIZE} total={total} onPageChange={setPage} loading={loading}>
      <div className={rows.frame}>
        <div className={cn(rows.list, rows.months)}>{rowsOf(pageRows, granularity, scaleOf(pageRows))}</div>
        <p className={cn(rows.legend, rows.small)}>
          {FLOWS_PL_BUCKET_SERIES.map((b) => (
            <span key={b.slug} className={rows.nowrap}>
              <i className={rows.dot} style={{ background: b.color }} />
              {flowsPlBucketLabel(b.slug)}
            </span>
          ))}
          <span className={rows.nowrap}>
            <i className={styles.line} style={{ background: FLOWS_PL_TOTAL_COLOR }} />
            {t("flows.pl.colTotal")}
          </span>
          <span>· {t("flows.pl.legendCumulative")}</span>
        </p>
      </div>
    </PaginatedTable>
  );
}
