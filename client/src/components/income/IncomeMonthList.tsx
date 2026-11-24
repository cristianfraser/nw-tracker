import { Fragment, useMemo, useState, type KeyboardEvent, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { Button } from "@crfrsr/ui";
import { DEMO_EDITS_LIMITED } from "../../demoEdits";
import { shownNameText, useTranslation } from "../../i18n";
import { flowPeriodLabel, formatFlowMoney, type FlowChartGranularity } from "../../flowsDisplay";
import { formatYearMonthLabel } from "../../formatDateLabel";
import { rollupIncomeMonthRowsByYear } from "../../incomeAggregates";
import type { DisplayUnit } from "../../queries/keys";
import type { FlowIncomeMonthLine, FlowIncomeMonthRow, FlowsIncomeResponse, ShownName } from "../../types";
import { usePatchIncomeMovementMutation } from "../../queries/mutations";
import { cn } from "../../cn";
import { TransferCounterpartyLine } from "../flows/TransferCounterpartyLine";
import { ChevronIcon } from "../ui/ChevronIcon";
import { ConfirmDialog } from "../ui/ConfirmDialog";
import { PaginatedTable, useClientPagination } from "../ui/PaginatedTable";
import { INCOME_KIND_SERIES } from "./incomeColors";
import { IncomeKindPicker, IncomeKindPill, IncomeLineRow } from "./IncomeLineRow";
import styles from "./IncomeRows.module.css";

const PAGE_SIZE = 12;

type ExcludeTarget = { movement_id: number; name: ShownName; received_on: string };

function onKeyActivate(e: KeyboardEvent, run: () => void) {
  if (e.key === "Enter" || e.key === " ") {
    e.preventDefault();
    run();
  }
}

/** A period's income by kind as one stacked bar, on the list's shared scale. */
function KindBar({ row, scale, className }: { row: FlowIncomeMonthRow; scale: number; className?: string }) {
  return (
    <span className={cn(styles.bar, className)} aria-hidden>
      {scale > 0
        ? INCOME_KIND_SERIES.filter((s) => row[s.kind] > 0).map((s) => (
            <i key={s.kind} style={{ width: `${(row[s.kind] / scale) * 100}%`, background: s.color }} />
          ))
        : null}
    </span>
  );
}

/**
 * The income page's main list: one row per month (or per year, which opens into its months) with
 * the period's income as a bar by kind and its total. A month opens into its lines — each credit
 * with its kind picker, and a salary with its payslip — so there is no separate list of every
 * line. Rows, lines and amounts are the server's (`aggregates.months`); this only picks.
 */
export function IncomeMonthList({
  data,
  granularity,
  displayUnit,
  loading,
  onOpenPayslip,
}: {
  data: FlowsIncomeResponse | undefined;
  granularity: FlowChartGranularity;
  displayUnit: DisplayUnit;
  loading?: boolean;
  /** Shows a payslip in the payslip list (a salary line's «receipt» link). */
  onOpenPayslip: (payslipId: number) => void;
}) {
  const { t } = useTranslation();
  const patchIncomeMovement = usePatchIncomeMovementMutation();
  const [openKeys, setOpenKeys] = useState<ReadonlySet<string>>(new Set());
  const [excludeTarget, setExcludeTarget] = useState<ExcludeTarget | null>(null);

  const months = data?.aggregates.months;
  const rows = useMemo(() => {
    if (!months) return [];
    return [...(granularity === "year" ? rollupIncomeMonthRowsByYear(months) : months)].reverse();
  }, [months, granularity]);
  const { page, setPage, pageRows, total } = useClientPagination(rows, PAGE_SIZE);

  const lookups = useMemo(() => {
    const payslipValues = new Map((data?.payroll_breakdown.payslips ?? []).map((p) => [p.payslip_id, p.values]));
    return {
      checking: new Map((data?.lines ?? []).map((l) => [l.movement_id, l])),
      manual: new Map((data?.manual ?? []).map((l) => [l.id, l])),
      payslip: new Map((data?.work_earnings ?? []).map((w) => [w.id, w])),
      payslipByMovement: new Map(
        (data?.work_earnings ?? []).flatMap((w) => (w.movement_id == null ? [] : [[w.movement_id, w] as const]))
      ),
      payslipValues,
    };
  }, [data]);

  if (rows.length === 0 && !loading) {
    return <p className="muted">{t("income.emptyMonths")}</p>;
  }

  const money = (v: number) => formatFlowMoney(v, displayUnit);
  const lineCount = (count: number) => t(count === 1 ? "income.sideListCountOne" : "income.sideListCount", { count });
  const toggle = (key: string) =>
    setOpenKeys((prev) => {
      const next = new Set(prev);
      if (!next.delete(key)) next.add(key);
      return next;
    });

  function payslipNote(payslipId: number): ReactNode {
    const w = lookups.payslip.get(payslipId);
    const v = lookups.payslipValues.get(payslipId);
    if (!w || !v) throw new Error(`income line names payslip ${payslipId}, which the payload does not carry`);
    return (
      <>
        <span>
          {t("income.payslipNote", {
            period: formatYearMonthLabel(w.period_month),
            gross: money(v.gross),
            deductions: money(v.deductions),
          })}
        </span>
        <button type="button" className={styles.linkButton} onClick={() => onOpenPayslip(payslipId)}>
          {t("income.payslipOpen")} ›
        </button>
      </>
    );
  }

  function lineRow(line: FlowIncomeMonthLine): ReactNode {
    const amount = money(line.amount);
    if (line.source === "checking") {
      const l = lookups.checking.get(line.id);
      if (!l) throw new Error(`income month names checking movement ${line.id}, which the payload does not list`);
      const payslip = lookups.payslipByMovement.get(line.id);
      return (
        <IncomeLineRow
          key={`checking-${line.id}`}
          date={line.received_on}
          kind={<IncomeKindPicker movementId={line.id} kind={line.income_kind} />}
          name={
            <>
              {shownNameText(l.name)}
              <TransferCounterpartyLine counterparty={l.transfer_counterparty} />
            </>
          }
          account={<Link to={`/account/${l.account_id}`}>{l.account_label}</Link>}
          amount={amount}
          action={
            DEMO_EDITS_LIMITED ? null : (
              <Button
                variant="secondary" size="sm"
                disabled={patchIncomeMovement.isPending}
                onClick={() => setExcludeTarget({ movement_id: l.movement_id, name: l.name, received_on: l.received_on })}
              >
                {t("income.excludeLine")}
              </Button>
            )
          }
          note={payslip ? payslipNote(payslip.id) : undefined}
        />
      );
    }
    if (line.source === "manual") {
      const l = lookups.manual.get(line.id);
      if (!l) throw new Error(`income month names manual entry ${line.id}, which the payload does not list`);
      return (
        <IncomeLineRow
          key={`manual-${line.id}`}
          date={line.received_on}
          kind={<IncomeKindPill kind={line.income_kind} />}
          name={
            <>
              {l.source ?? "—"}
              {l.note ? <div className={cn("muted", styles.small)}>{l.note}</div> : null}
            </>
          }
          account={t("income.originManual")}
          amount={amount}
        />
      );
    }
    const w = lookups.payslip.get(line.id);
    if (!w) throw new Error(`income month names payslip ${line.id}, which the payload does not list`);
    return (
      <IncomeLineRow
        key={`payslip-${line.id}`}
        date={line.received_on}
        kind={<IncomeKindPill kind={line.income_kind} />}
        name={w.employer_name}
        account={t("workEarnings.usdWire")}
        amount={amount}
        note={payslipNote(w.id)}
      />
    );
  }

  function periodRows(list: readonly FlowIncomeMonthRow[], grain: "month" | "year", scale: number): ReactNode {
    return list.map((row) => {
      const key = grain === "year" ? row.period_month.slice(0, 4) : row.period_month;
      const opens = row.line_count > 0;
      const open = opens && openKeys.has(key);
      const period = flowPeriodLabel(row.period_month, grain);
      // The row's figures carry no labels of their own, so its accessible name says what each is.
      const rowLabel = t("income.rowLabel", {
        period,
        total: money(row.total),
        parts: INCOME_KIND_SERIES.filter((s) => row[s.kind] !== 0)
          .map((s) => `${t(`income.chart.${s.kind}`)} ${money(row[s.kind])}`)
          .join(", "),
        lines: lineCount(row.line_count),
      });
      const yearMonths =
        open && grain === "year"
          ? (months ?? []).filter((m) => m.period_month.startsWith(key) && m.line_count > 0).reverse()
          : [];
      return (
        <Fragment key={key}>
          <div
            className={cn(styles.row, opens && styles.opens, open && styles.open)}
            {...(opens
              ? {
                  role: "button",
                  tabIndex: 0,
                  "aria-expanded": open,
                  "aria-label": rowLabel,
                  onClick: () => toggle(key),
                  onKeyDown: (e: KeyboardEvent) => onKeyActivate(e, () => toggle(key)),
                }
              : null)}
          >
            <span className={styles.mPeriod}>{period}</span>
            <KindBar row={row} scale={scale} className={styles.mBar} />
            <span className={cn(styles.parts, styles.mParts, styles.small)}>
              {INCOME_KIND_SERIES.filter((s) => row[s.kind] !== 0).map((s) => (
                <span key={s.kind} className={styles.nowrap} title={t(`income.chart.${s.kind}`)}>
                  <i className={styles.dot} style={{ background: s.color }} />
                  <span className="visually-hidden">{t(`income.chart.${s.kind}`)} </span>
                  <span className="mono">{money(row[s.kind])}</span>
                </span>
              ))}
            </span>
            <span className={cn("mono", styles.num, styles.strong, styles.mTotal)}>{money(row.total)}</span>
            <span
              className={cn("muted", styles.num, styles.small, styles.mCount)}
              title={t("expenses.creditCard.colLineCount")}
            >
              {row.line_count > 0 ? (
                <>
                  <span aria-hidden>{row.line_count}</span>
                  <span className="visually-hidden">{lineCount(row.line_count)}</span>
                </>
              ) : (
                ""
              )}
            </span>
            {opens ? <ChevronIcon className={styles.chevron} /> : <span />}
          </div>
          {open ? (
            <div className={styles.sub}>
              {grain === "year" ? (
                <div className={cn(styles.list, styles.months)}>
                  {periodRows(yearMonths, "month", Math.max(0, ...yearMonths.map((m) => m.total)))}
                </div>
              ) : (
                <div className={cn(styles.list, styles.lines)}>{row.lines.map(lineRow)}</div>
              )}
              <div className={cn(styles.subFoot, styles.small)}>
                <span>{t("income.colCumulative")}</span>
                <span className="mono">{money(row.cumulative)}</span>
              </div>
            </div>
          ) : null}
        </Fragment>
      );
    });
  }

  return (
    <>
      <PaginatedTable page={page} pageSize={PAGE_SIZE} total={total} onPageChange={setPage} loading={loading}>
        <div className={styles.frame}>
          <div className={cn(styles.list, styles.months)}>
            {periodRows(pageRows, granularity === "year" ? "year" : "month", Math.max(0, ...pageRows.map((r) => r.total)))}
          </div>
          <p className={cn(styles.legend, styles.small)}>
            {INCOME_KIND_SERIES.map((s) => (
              <span key={s.kind} className={styles.nowrap}>
                <i className={styles.dot} style={{ background: s.color }} />
                {t(`income.chart.${s.kind}`)}
              </span>
            ))}
          </p>
        </div>
      </PaginatedTable>

      <ConfirmDialog
        open={excludeTarget != null}
        title={t("income.excludeConfirmTitle")}
        message={
          excludeTarget
            ? t("income.excludeConfirmMessage", {
                date: excludeTarget.received_on,
                description: shownNameText(excludeTarget.name),
              })
            : ""
        }
        confirmLabel={t("income.excludeConfirmAction")}
        cancelLabel={t("income.excludeConfirmCancel")}
        confirmDisabled={patchIncomeMovement.isPending}
        onCancel={() => setExcludeTarget(null)}
        onConfirm={() => {
          if (!excludeTarget) return;
          patchIncomeMovement.mutate(
            { movement_id: excludeTarget.movement_id, excluded: true },
            { onSuccess: () => setExcludeTarget(null) }
          );
        }}
      />
    </>
  );
}
