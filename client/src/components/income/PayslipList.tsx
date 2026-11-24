import { Fragment, useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { useTranslation } from "../../i18n";
import { formatFlowMoney } from "../../flowsDisplay";
import { formatPct } from "../../format";
import { formatYearMonthLabel } from "../../formatDateLabel";
import { formatIncomeMoney } from "../../incomeAggregates";
import type { DisplayUnit } from "../../queries/keys";
import type {
  FlowWorkEarningRow,
  PayrollBreakdownField,
  PayrollBreakdownPayload,
  PayrollBreakdownValues,
  PayrollEarningType,
  PayslipChecksRow,
} from "../../types";
import { usePatchWorkEarningMutation } from "../../queries/mutations";
import { useSurfacePrefs } from "../../surfaceDisplayPrefs";
import { cn } from "../../cn";
import { ChevronIcon } from "../ui/ChevronIcon";
import { PaginatedTable, pageForFirstMatch, useClientPagination } from "../ui/PaginatedTable";
import { Pill } from "../ui/Pill";
import { SurfaceControls } from "../ui/SurfaceControls";
import { incomeKindColor, PAYROLL_DEDUCTIONS, PAYROLL_STACK } from "./incomeColors";
import styles from "./IncomeRows.module.css";

const PAGE_SIZE = 12;

/** A payslip's printed earnings lines, in the order it prints them. */
const EARNING_LINES = [
  ["base_salary_clp", "workEarnings.colBase"],
  ["gratificacion_clp", "workEarnings.colGratificacion"],
  ["colacion_clp", "workEarnings.colColacion"],
  ["movilizacion_clp", "workEarnings.colMovilizacion"],
] as const;

function onKeyActivate(e: KeyboardEvent, run: () => void) {
  if (e.key === "Enter" || e.key === " ") {
    e.preventDefault();
    run();
  }
}

/** Gross pay as one bar: net pay, then each deduction group. */
function GrossBar({ values, className }: { values: PayrollBreakdownValues; className?: string }) {
  return (
    <span className={cn(styles.bar, className)} aria-hidden>
      {values.gross > 0
        ? PAYROLL_STACK.filter((s) => values[s.field] > 0).map((s) => (
            <i key={s.field} style={{ width: `${(values[s.field] / values.gross) * 100}%`, background: s.color }} />
          ))
        : null}
    </span>
  );
}

/**
 * «Liquidaciones de sueldo»: one row per payslip — period, employer, gross pay as a bar split into
 * net pay and deductions, net pay, and the legal-parameter check — which opens into its receipt
 * (earnings, deductions, net pay, the linked deposit, the type). «Año» shows each year's payslips
 * added up, opening into the year's deductions. Every figure is the server's (`work_earnings`,
 * `payroll_breakdown`, `payslip_checks`).
 */
export function PayslipList({
  rows,
  breakdown,
  checks,
  displayUnit,
  loading,
  focus,
}: {
  rows: readonly FlowWorkEarningRow[];
  breakdown: PayrollBreakdownPayload | undefined;
  checks: readonly PayslipChecksRow[];
  displayUnit: DisplayUnit;
  loading?: boolean;
  /** A payslip to show: its page, opened and scrolled to. `seq` changes on every request. */
  focus: { payslipId: number; seq: number } | null;
}) {
  const { t } = useTranslation();
  const patchWorkEarning = usePatchWorkEarningMutation();
  const prefs = useSurfacePrefs("income.payroll.table", "month", "total");
  const byYear = prefs.period === "year";
  const [openKeys, setOpenKeys] = useState<ReadonlySet<string>>(new Set());
  const focusRef = useRef<HTMLDivElement | null>(null);

  const sorted = useMemo(
    () =>
      [...rows].sort(
        (a, b) => b.period_month.localeCompare(a.period_month) || (b.pay_date ?? "").localeCompare(a.pay_date ?? "") || b.id - a.id
      ),
    [rows]
  );
  const years = useMemo(() => [...(breakdown?.years ?? [])].reverse(), [breakdown]);
  const valuesById = useMemo(() => new Map((breakdown?.payslips ?? []).map((p) => [p.payslip_id, p.values])), [breakdown]);
  const checksById = useMemo(() => new Map(checks.map((c) => [c.payslip_id, c])), [checks]);

  const focusPage = focus ? pageForFirstMatch(sorted, PAGE_SIZE, (r) => r.id === focus.payslipId) : 1;
  const payslipPages = useClientPagination(sorted, PAGE_SIZE, focusPage);
  const yearPages = useClientPagination(years, PAGE_SIZE);
  const setPeriod = prefs.setPeriod;
  const setPayslipPage = payslipPages.setPage;

  // A salary line's «receipt» link: the payslip view, its page, the row open and in sight.
  useEffect(() => {
    if (!focus) return;
    setPeriod("month");
    setPayslipPage(focusPage);
    setOpenKeys((prev) => new Set(prev).add(`p${focus.payslipId}`));
    const frame = requestAnimationFrame(() => focusRef.current?.scrollIntoView({ block: "center", behavior: "smooth" }));
    return () => cancelAnimationFrame(frame);
    // Only a new request (seq) re-runs this; the page is derived from it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus?.seq]);

  const money = (v: number) => formatFlowMoney(v, displayUnit);
  const fieldLabel = (f: PayrollBreakdownField) => t(`income.payroll.fields.${f}`);
  const toggle = (key: string) =>
    setOpenKeys((prev) => {
      const next = new Set(prev);
      if (!next.delete(key)) next.add(key);
      return next;
    });
  const rowProps = (key: string, open: boolean) => ({
    role: "button",
    tabIndex: 0,
    "aria-expanded": open,
    onClick: () => toggle(key),
    onKeyDown: (e: KeyboardEvent) => onKeyActivate(e, () => toggle(key)),
  });

  function checkStatus(c: PayslipChecksRow | undefined): ReactNode {
    if (!c) return <span className="muted">—</span>;
    if (c.pending) return <span className="muted">{t("workEarnings.checksPendingShort")}</span>;
    if (c.differences.length === 0) return <span className={styles.ok}>{t("workEarnings.checksOk")}</span>;
    return <span className={styles.bad}>{t("workEarnings.checksDifferences", { count: c.differences.length })}</span>;
  }

  function deductionPairs(values: PayrollBreakdownValues, withShare: boolean): ReactNode {
    return PAYROLL_DEDUCTIONS.filter((s) => values[s.field] !== 0).map((s) => (
      <FragmentPair
        key={s.field}
        label={
          <>
            <i className={styles.dot} style={{ background: s.color }} />
            {fieldLabel(s.field)}
          </>
        }
        value={
          <>
            {money(-values[s.field])}
            {withShare && values.gross > 0 ? (
              <span className={cn("muted", styles.small)}> {formatPct((values[s.field] / values.gross) * 100, 1)}</span>
            ) : null}
          </>
        }
      />
    ));
  }

  function receipt(row: FlowWorkEarningRow, values: PayrollBreakdownValues, c: PayslipChecksRow | undefined): ReactNode {
    return (
      <div className={styles.sub}>
        <div className={styles.receipt}>
          <div className={styles.pairs}>
            <span className={styles.pairsHead}>{t("workEarnings.receiptEarnings")}</span>
            {EARNING_LINES.filter(([field]) => row[field]).map(([field, label]) => (
              <FragmentPair key={field} label={t(label)} value={formatFlowMoney(row[field] ?? 0, displayUnit)} muted />
            ))}
            <span className={styles.pairsTotal}>{fieldLabel("gross")}</span>
            <span className={cn("mono", styles.num, styles.pairsTotal)}>{money(values.gross)}</span>
          </div>
          <div className={styles.pairs}>
            <span className={styles.pairsHead}>{fieldLabel("deductions")}</span>
            {deductionPairs(values, false)}
            <span className={styles.pairsTotal}>{t("income.colTotal")}</span>
            <span className={cn("mono", styles.num, styles.pairsTotal)}>{money(-values.deductions)}</span>
          </div>
          <div className={styles.receiptFoot}>
            <span>
              <i className={styles.dot} style={{ background: PAYROLL_STACK[0]!.color }} />
              {fieldLabel("net")}
            </span>
            <span className={cn("mono", styles.strong)}>{money(values.net)}</span>
          </div>
          {values.employer_retirement !== 0 ? (
            <div className={cn(styles.receiptFoot, "muted", styles.small)}>
              <span>{fieldLabel("employer_retirement")}</span>
              <span className="mono">{money(values.employer_retirement)}</span>
            </div>
          ) : null}
          <div className={cn(styles.receiptFoot, styles.small)}>
            <span>
              <span className="muted">{t("workEarnings.colInflow")}: </span>
              {row.movement_id != null && row.linked_received_on ? (
                <>
                  <span className="mono">
                    {row.linked_received_on} {formatIncomeMoney(row.linked_amount ?? row.liquido, displayUnit)}
                  </span>
                  {row.linked_account_label ? <span className="muted"> · {row.linked_account_label}</span> : null}
                  {row.link_source ? <span className="muted"> ({t(`workEarnings.linkSource.${row.link_source}`)})</span> : null}
                </>
              ) : row.wire_received_on ? (
                <span className="mono">
                  {row.wire_received_on} <span className="muted">({t("workEarnings.usdWire")})</span>
                </span>
              ) : (
                <span className="muted">{t("workEarnings.unlinked")}</span>
              )}
            </span>
            <select
              value={row.earning_type}
              disabled={patchWorkEarning.isPending}
              onChange={(e) => patchWorkEarning.mutate({ id: row.id, earning_type: e.target.value as PayrollEarningType })}
              aria-label={t("workEarnings.colType")}
            >
              <option value="salary">{t("income.chart.salary")}</option>
              <option value="severance">{t("income.chart.severance")}</option>
            </select>
          </div>
          {c && (c.pending || c.differences.length > 0) ? (
            <ul className={cn(styles.receiptChecks, styles.small)}>
              {c.pending ? <li className="muted">{t("workEarnings.checksPending")}</li> : null}
              {c.differences.map((d) => (
                <li key={d.check} className={styles.bad}>
                  {t("workEarnings.checkDetail", {
                    check: t(`workEarnings.checks.${d.check}`),
                    expected: formatFlowMoney(d.expected, c.currency),
                    printed: formatFlowMoney(d.printed, c.currency),
                  })}
                  {c.origin === "rebuilt" ? <span className="muted"> ({t("workEarnings.rebuilt")})</span> : null}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      </div>
    );
  }

  const empty = rows.length === 0 && !loading;

  return (
    <>
      <div className="chart-panel-title-row">
        <h3>{t("workEarnings.sectionTitle")}</h3>
        <SurfaceControls period={prefs.period} onPeriodChange={prefs.setPeriod} periodOptions={["month", "year"]} />
      </div>
      {empty ? (
        <p className="muted">{t("workEarnings.empty")}</p>
      ) : byYear ? (
        <PaginatedTable
          page={yearPages.page}
          pageSize={PAGE_SIZE}
          total={yearPages.total}
          onPageChange={yearPages.setPage}
          loading={loading}
        >
          <div className={styles.frame}>
            <div className={cn(styles.list, styles.years)}>
              {yearPages.pageRows.map((y) => {
                const key = `y${y.period}`;
                const open = openKeys.has(key);
                const v = y.values;
                return (
                  <Fragment key={key}>
                    <div className={cn(styles.row, styles.opens, open && styles.open)} {...rowProps(key, open)}>
                      <span className={styles.pPeriod}>{y.period}</span>
                      <span className={cn("muted", styles.small, styles.pEmployer, styles.nowrap)}>
                        {t("workEarnings.payslipCount", { count: y.payslips })}
                      </span>
                      <span className={cn("mono muted", styles.num, styles.pGross)}>{money(v.gross)}</span>
                      <GrossBar values={v} className={styles.pBar} />
                      <span className={cn("mono", styles.num, styles.strong, styles.pNet)}>{money(v.net)}</span>
                      <span className={cn("mono muted", styles.num, styles.small, styles.pCheck)}>
                        {v.gross > 0 ? formatPct((-v.deductions / v.gross) * 100, 1) : ""}
                      </span>
                      <ChevronIcon className={styles.chevron} />
                    </div>
                    {open ? (
                      <div className={styles.sub}>
                        <div className={styles.receipt}>
                          <div className={styles.pairs}>
                            <FragmentPair label={fieldLabel("gross")} value={money(v.gross)} />
                            {deductionPairs(v, true)}
                            <span className={styles.pairsTotal}>
                              <i className={styles.dot} style={{ background: PAYROLL_STACK[0]!.color }} />
                              {fieldLabel("net")}
                            </span>
                            <span className={cn("mono", styles.num, styles.pairsTotal, styles.strong)}>{money(v.net)}</span>
                          </div>
                        </div>
                      </div>
                    ) : null}
                  </Fragment>
                );
              })}
            </div>
          </div>
        </PaginatedTable>
      ) : (
        <PaginatedTable
          page={payslipPages.page}
          pageSize={PAGE_SIZE}
          total={payslipPages.total}
          onPageChange={payslipPages.setPage}
          loading={loading}
        >
          <div className={styles.frame}>
            <div className={cn(styles.list, styles.payslips)}>
              {payslipPages.pageRows.map((row) => {
                const key = `p${row.id}`;
                const open = openKeys.has(key);
                const values = valuesById.get(row.id);
                if (!values) throw new Error(`payslip ${row.id} has no payroll breakdown`);
                const c = checksById.get(row.id);
                return (
                  <Fragment key={key}>
                    <div
                      ref={focus?.payslipId === row.id ? focusRef : undefined}
                      className={cn(styles.row, styles.opens, open && styles.open)}
                      {...rowProps(key, open)}
                    >
                      {/* A US pay stub is one of several in its month: its pay date tells them apart. */}
                      <span className={styles.pPeriod}>{row.pay_date ?? formatYearMonthLabel(row.period_month)}</span>
                      <span
                        className={cn("muted", styles.pEmployer, styles.ellipsis)}
                        title={row.employer_rut ? `${row.employer_name} · ${row.employer_rut}` : row.employer_name}
                      >
                        {row.earning_type === "severance" ? (
                          <>
                            <Pill
                              size="small"
                              uppercase={false}
                              label={t("income.chart.severance")}
                              backgroundColor={incomeKindColor("severance")}
                            />{" "}
                          </>
                        ) : null}
                        {row.employer_name}
                      </span>
                      <span className={cn("mono muted", styles.num, styles.pGross)}>{money(values.gross)}</span>
                      <GrossBar values={values} className={styles.pBar} />
                      <span className={cn("mono", styles.num, styles.strong, styles.pNet)}>{money(values.net)}</span>
                      <span className={cn(styles.small, styles.pCheck, styles.nowrap)}>{checkStatus(c)}</span>
                      <ChevronIcon className={styles.chevron} />
                    </div>
                    {open ? receipt(row, values, c) : null}
                  </Fragment>
                );
              })}
            </div>
          </div>
        </PaginatedTable>
      )}
      {empty ? null : (
        <p className={cn(styles.legend, styles.small)}>
          {PAYROLL_STACK.filter((s) => years.some((y) => y.values[s.field] !== 0)).map((s) => (
            <span key={s.field} className={styles.nowrap}>
              <i className={styles.dot} style={{ background: s.color }} />
              {fieldLabel(s.field)}
            </span>
          ))}
        </p>
      )}
    </>
  );
}

/** One label and amount pair of a `pairs` grid. */
function FragmentPair({ label, value, muted }: { label: ReactNode; value: ReactNode; muted?: boolean }) {
  return (
    <>
      <span className={muted ? "muted" : undefined}>{label}</span>
      <span className={cn("mono", styles.num, muted && "muted")}>{value}</span>
    </>
  );
}
