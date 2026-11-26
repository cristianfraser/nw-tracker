import { Fragment, useMemo, useState, type KeyboardEvent, type ReactNode } from "react";
import { cn } from "../../cn";
import { flowPeriodLabel, formatFlowMoney } from "../../flowsDisplay";
import { rollupFlowsOverviewRowsByYear } from "../../flowsOverviewRows";
import { useTranslation } from "../../i18n";
import type { DisplayUnit } from "../../queries/keys";
import type { FlowsOverviewRow, FlowsOverviewTotals } from "../../types";
import { ChevronIcon } from "../ui/ChevronIcon";
import { PaginatedTable, useClientPagination } from "../ui/PaginatedTable";
import rows from "../income/IncomeRows.module.css";
import { flowsOverviewBar, flowsOverviewBarExtent } from "./flowsOverviewBar";
import { FLOWS_OVERVIEW_COLORS, FLOWS_OVERVIEW_SERIES, type FlowsOverviewSeries } from "./flowsOverviewColors";
import styles from "./FlowsOverviewRows.module.css";

const PAGE_SIZE = 12;

const SERIES_LABEL_KEY: Record<FlowsOverviewSeries, string> = {
  income: "flows.overview.income",
  expenses: "flows.overview.expenses",
  deposits: "flows.overview.deposits",
  pl: "flows.overview.pl",
};

/** One line of an open period's sums: a figure of the server's row, as the sum counts it. */
type SumLine = { labelKey: string; value: (r: FlowsOverviewTotals) => number; muted?: boolean };

/**
 * The period's twelve figures as the three sums the server derives them by
 * (`derivedFlowsOverviewFields`): each list adds up to its last line. Savings is the subtotal of
 * the two lines above it, so it reads muted and is not added again.
 */
const SUMS: readonly { headKey: string; lines: readonly SumLine[]; total: SumLine }[] = [
  {
    headKey: "flows.overview.groupCash",
    lines: [
      { labelKey: "flows.overview.income", value: (r) => r.income },
      { labelKey: "flows.overview.expenses", value: (r) => -r.expenses },
      { labelKey: "flows.overview.savings", value: (r) => r.savings, muted: true },
      { labelKey: "flows.overview.deposits", value: (r) => -r.deposits },
      { labelKey: "flows.overview.cardSpentMinusPaid", value: (r) => r.card_net },
      { labelKey: "flows.overview.cashFx", value: (r) => r.cash_fx },
      { labelKey: "flows.overview.cashUnexplained", value: (r) => r.cash_unexplained },
    ],
    total: { labelKey: "flows.overview.cashChange", value: (r) => r.cash_change },
  },
  {
    headKey: "flows.overview.groupInvestments",
    lines: [
      { labelKey: "flows.overview.deposits", value: (r) => r.deposits },
      { labelKey: "flows.overview.contributionsOutsidePayslip", value: (r) => r.contributions_outside_payslip },
      { labelKey: "flows.overview.pl", value: (r) => r.pl },
    ],
    total: { labelKey: "flows.overview.investmentsChange", value: (r) => r.investments_change },
  },
  {
    headKey: "flows.overview.groupNetWorth",
    lines: [
      { labelKey: "flows.overview.savings", value: (r) => r.savings },
      { labelKey: "flows.overview.contributionsOutsidePayslip", value: (r) => r.contributions_outside_payslip },
      { labelKey: "flows.overview.pl", value: (r) => r.pl },
      { labelKey: "flows.overview.cashFx", value: (r) => r.cash_fx },
    ],
    total: { labelKey: "flows.overview.netWorthChange", value: (r) => r.net_worth_change },
  },
];

function onKeyActivate(e: KeyboardEvent, run: () => void) {
  if (e.key === "Enter" || e.key === " ") {
    e.preventDefault();
    run();
  }
}

/** A series' mark beside its amount: income the chart's line, the rest the bar's colours. */
function SeriesMark({ series }: { series: FlowsOverviewSeries }) {
  return (
    <i
      className={series === "income" ? styles.line : rows.dot}
      style={{ background: FLOWS_OVERVIEW_COLORS[series] }}
    />
  );
}

/** A period's flows around zero on the list's shared scale (`scale` = the longest side drawn). */
function ZeroBar({ row, scale, className }: { row: FlowsOverviewTotals; scale: number; className?: string }) {
  const bar = flowsOverviewBar(row);
  const pct = (amount: number) => `${(amount / scale) * 100}%`;
  return (
    <span className={cn(styles.bar, className)} aria-hidden>
      <span className={cn(styles.side, styles.out)}>
        {scale > 0
          ? bar.left.map((s) => (
              <i key={s.series} style={{ width: pct(s.amount), background: FLOWS_OVERVIEW_COLORS[s.series] }} />
            ))
          : null}
      </span>
      <span className={cn(styles.side, styles.in)}>
        {scale > 0
          ? bar.right.map((s) => (
              <i key={s.series} style={{ width: pct(s.amount), background: FLOWS_OVERVIEW_COLORS[s.series] }} />
            ))
          : null}
        {scale > 0 && bar.income > 0 ? (
          <i className={styles.mark} style={{ left: `min(${pct(bar.income)}, 100% - 1px)`, background: FLOWS_OVERVIEW_COLORS.income }} />
        ) : null}
      </span>
    </span>
  );
}

/**
 * The flows overview's period list, on the income page's month rows: one row per month (or per
 * year, which opens into its sums and its months) with the period's flows as a bar around zero
 * (the «Flows and P/L» chart's series and colours), each series' amount and the net-worth change.
 * A period opens into its figures as three sums. Rows are the server's (`months`); a year is their
 * field-by-field sum (`rollupFlowsOverviewRowsByYear`). Full history, newest first.
 */
export function FlowsOverviewPeriodList({
  months,
  granularity,
  displayUnit,
  loading,
}: {
  /** The server's month rows, oldest first; null until the payload arrives. */
  months: readonly FlowsOverviewRow[] | null;
  granularity: "month" | "year";
  displayUnit: DisplayUnit;
  loading?: boolean;
}) {
  const { t } = useTranslation();
  const [openKeys, setOpenKeys] = useState<ReadonlySet<string>>(new Set());

  const periodRows = useMemo(() => {
    if (!months) return [];
    return [...(granularity === "year" ? rollupFlowsOverviewRowsByYear(months) : months)].reverse();
  }, [months, granularity]);
  const { page, setPage, pageRows, total } = useClientPagination(periodRows, PAGE_SIZE);

  if (periodRows.length === 0 && !loading) {
    return <p className="muted">{t("flows.overview.emptyMonths")}</p>;
  }

  const money = (v: number) => formatFlowMoney(v, displayUnit);
  const toggle = (key: string) =>
    setOpenKeys((prev) => {
      const next = new Set(prev);
      if (!next.delete(key)) next.add(key);
      return next;
    });
  const scaleOf = (list: readonly FlowsOverviewRow[]) => Math.max(0, ...list.map(flowsOverviewBarExtent));

  function sums(row: FlowsOverviewTotals): ReactNode {
    return (
      <div className={styles.sums}>
        {SUMS.map((sum) => (
          <div key={sum.headKey} className={rows.pairs}>
            <span className={rows.pairsHead}>{t(sum.headKey)}</span>
            {sum.lines.map((line) => (
              <Fragment key={line.labelKey}>
                <span className={line.muted ? "muted" : undefined}>{t(line.labelKey)}</span>
                <span className={cn("mono", rows.num, line.muted && "muted")}>{money(line.value(row))}</span>
              </Fragment>
            ))}
            <span className={cn(rows.pairsTotal, rows.strong)}>{t(sum.total.labelKey)}</span>
            <span className={cn("mono", rows.num, rows.pairsTotal, rows.strong)}>{money(sum.total.value(row))}</span>
          </div>
        ))}
      </div>
    );
  }

  function rowsOf(list: readonly FlowsOverviewRow[], grain: "month" | "year", scale: number): ReactNode {
    return list.map((row) => {
      const key = grain === "year" ? row.period_month.slice(0, 4) : row.period_month;
      const open = openKeys.has(key);
      const period = flowPeriodLabel(row.period_month, grain);
      // The row's figures carry no labels of their own, so its accessible name says what each is.
      const rowLabel = t("flows.overview.rowLabel", {
        period,
        total: money(row.net_worth_change),
        parts: FLOWS_OVERVIEW_SERIES.map((s) => `${t(SERIES_LABEL_KEY[s])} ${money(row[s])}`).join(", "),
      });
      const yearMonths =
        open && grain === "year" ? (months ?? []).filter((m) => m.period_month.startsWith(key)).reverse() : [];
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
            <ZeroBar row={row} scale={scale} className={rows.mBar} />
            <span className={cn(rows.parts, rows.mParts, rows.small)}>
              {/* Every series on every row, a zero included: the four amounts keep their places. */}
              {FLOWS_OVERVIEW_SERIES.map((s) => (
                <span key={s} className={rows.nowrap} title={t(SERIES_LABEL_KEY[s])}>
                  <SeriesMark series={s} />
                  <span className="mono">{money(row[s])}</span>
                </span>
              ))}
            </span>
            <span
              className={cn("mono", rows.num, rows.strong, rows.mTotal)}
              title={t("flows.overview.netWorthChange")}
            >
              {money(row.net_worth_change)}
            </span>
            {/* The income rows' line-count slot: these rows have none. */}
            <span className={rows.mCount} />
            <ChevronIcon className={rows.chevron} />
          </div>
          {open ? (
            <div className={rows.sub}>
              {sums(row)}
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
        <div className={cn(rows.list, rows.months)}>
          {rowsOf(pageRows, granularity, scaleOf(pageRows))}
        </div>
        <p className={cn(rows.legend, rows.small)}>
          {FLOWS_OVERVIEW_SERIES.map((s) => (
            <span key={s} className={rows.nowrap}>
              <SeriesMark series={s} />
              {t(SERIES_LABEL_KEY[s])}
            </span>
          ))}
          <span>· {t("flows.overview.legendTotal")}</span>
        </p>
      </div>
    </PaginatedTable>
  );
}
