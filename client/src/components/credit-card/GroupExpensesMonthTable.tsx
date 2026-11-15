import { useCallback, useMemo, useState } from "react";
import { useTranslation } from "../../i18n";
import { flowPeriodLabel, formatFlowMoney, type FlowChartGranularity } from "../../flowsDisplay";
import type { DisplayUnit } from "../../queries/keys";
import type { CcExpenseBigGroupDto, CcExpenseCategoryDto, FlowCcExpenseMonthRow } from "../../types";
import { useFlowsExpenseLines } from "../../queries/hooks";
import { Loadable } from "../ui/Loadable";
import type { CcInstallmentGastosMode } from "../../expenseLineShape";
import { PaginatedTable, pageForFirstMatch, useClientPagination } from "../ui/PaginatedTable";
import { chileTodayYmd } from "../../calendarMonth";
import { useModalPeriodNav } from "../../periodModalNav";
import { ColumnTable, type TableColumn } from "../ui/ColumnTable";
import { Modal } from "../ui/Modal";
import { Button } from "@crfrsr/ui";
import {
  buildCreditCardExpenseMonthBucket,
  CreditCardExpenseMonthModalSections,
  emptyCreditCardExpenseMonthBucket,
} from "./CreditCardExpenseMonthModalSections";
import {
  CreditCardExpenseLinesBulkFooter,
  CreditCardExpenseLinesSelectionProvider,
} from "./CreditCardExpenseLinesSelection";

const periodKeyOf = (row: FlowCcExpenseMonthRow) => row.period_month;

/** True when the row's period is the current Chile month (or current year in year-rollup mode). */
function isCurrentPeriodRow(
  periodMonth: string,
  periodGranularity: FlowChartGranularity,
  todayYm: string
): boolean {
  if (periodGranularity === "year") return periodMonth.slice(0, 4) === todayYm.slice(0, 4);
  return periodMonth === todayYm;
}

const PAGE_SIZE = 12;

export function GroupExpensesMonthTable({
  rows,
  includePreTax,
  categories,
  bigGroups = [],
  installmentMode,
  displayUnit = "clp",
  periodGranularity = "month",
  loading,
}: {
  rows: readonly FlowCcExpenseMonthRow[];
  /** The page's «Include pre-tax expenses»: the month modal lists the payroll deductions too. */
  includePreTax: boolean;
  categories: readonly CcExpenseCategoryDto[];
  bigGroups?: readonly CcExpenseBigGroupDto[];
  installmentMode: CcInstallmentGastosMode;
  displayUnit?: DisplayUnit;
  periodGranularity?: FlowChartGranularity;
  loading?: boolean;
}) {
  const { t } = useTranslation();
  const [modalOpen, setModalOpen] = useState(false);
  const [selected, setSelected] = useState<FlowCcExpenseMonthRow | null>(null);

  const closeModal = useCallback(() => {
    setModalOpen(false);
    setSelected(null);
  }, []);

  const openMonth = useCallback((row: FlowCcExpenseMonthRow) => {
    setSelected(row);
    setModalOpen(true);
  }, []);

  const currentYm = chileTodayYmd().slice(0, 7);

  // The selected period's lines, fetched while the modal is open. In year mode a row's
  // `period_month` is the year's closing month and the modal lists that month's lines, as before.
  const monthLines = useFlowsExpenseLines(
    displayUnit,
    selected ? { kind: "month", period_month: selected.period_month, include_pre_tax: includePreTax } : null,
    modalOpen
  );
  const monthLinesLoading = selected != null && monthLines.data == null;

  const monthBucket = useMemo(() => {
    if (!selected || !monthLines.data) return emptyCreditCardExpenseMonthBucket();
    return buildCreditCardExpenseMonthBucket(monthLines.data.lines, selected.period_month, installmentMode);
  }, [monthLines.data, selected, installmentMode]);

  const monthModalLines = useMemo(
    () => [
      ...monthBucket.purchases,
      ...monthBucket.installments,
      ...monthBucket.abonos,
      ...monthBucket.excluded,
    ],
    [monthBucket]
  );


  const sortedRows = useMemo(
    () => [...rows].sort((a, b) => b.period_month.localeCompare(a.period_month)),
    [rows]
  );

  // Land on the page holding the current period (rows are newest-first and include future cuota
  // buckets). Year-rollup rows use `YYYY-12` as period_month, so compare on year in that mode.
  const defaultPage = useMemo(() => {
    const today = chileTodayYmd();
    if (periodGranularity === "year") {
      const currentYear = today.slice(0, 4);
      return pageForFirstMatch(sortedRows, PAGE_SIZE, (r) => r.period_month.slice(0, 4) <= currentYear);
    }
    const currentYm = today.slice(0, 7);
    return pageForFirstMatch(sortedRows, PAGE_SIZE, (r) => r.period_month <= currentYm);
  }, [sortedRows, periodGranularity]);

  const { page, setPage, pageRows, total } = useClientPagination(sortedRows, PAGE_SIZE, defaultPage);

  const titleNav = useModalPeriodNav({
    rows: sortedRows,
    selectedKey: selected?.period_month ?? null,
    keyOf: periodKeyOf,
    onSelect: setSelected,
    labels: { prev: t("common.modalPrevPeriod"), next: t("common.modalNextPeriod") },
  });

  const columns: TableColumn<FlowCcExpenseMonthRow>[] = [
    {
      key: "month",
      header: t("accountDetail.monthCloseColumn"),
      className: "mono",
      sort: { type: "date", value: (row) => row.as_of_date },
      cell: (row) => (
        <>
          <Button variant="link" onClick={() => openMonth(row)}>
            {row.as_of_date} ({flowPeriodLabel(row.period_month, periodGranularity)})
          </Button>
          {isCurrentPeriodRow(row.period_month, periodGranularity, currentYm) ? (
            <span className="muted" title={t("expenses.creditCard.currentMonthHint")}>
              {" "}
              *
            </span>
          ) : null}
        </>
      ),
      title: true,
    },
    {
      key: "gastos",
      header: t("expenses.creditCard.colMonthExpense"),
      className: "mono",
      sort: { type: "number", value: (row) => row.gastos_mes },
      cell: (row) => formatFlowMoney(row.gastos_mes, displayUnit),
    },
    {
      key: "gastos_real",
      header: t("expenses.creditCard.colMonthExpenseReal"),
      className: "mono muted",
      cardClassName: "muted",
      sort: { type: "number", value: (row) => row.gastos_real_mes },
      cell: (row) => formatFlowMoney(row.gastos_real_mes, displayUnit),
    },
    {
      key: "cumulative",
      header: t("expenses.creditCard.colCumulative"),
      className: "mono",
      sort: { type: "number", value: (row) => row.gastos_acumulado },
      cell: (row) => formatFlowMoney(row.gastos_acumulado, displayUnit),
    },
    {
      key: "lines",
      header: t("expenses.creditCard.colLineCount"),
      className: "mono muted",
      cardClassName: "muted",
      sort: { type: "number", value: (row) => row.line_count },
      cell: (row) => row.line_count,
    },
  ];

  if (rows.length === 0 && !loading) {
    return <p className="muted">{t("expenses.creditCard.emptyMonths")}</p>;
  }

  return (
    <>
      <PaginatedTable page={page} pageSize={PAGE_SIZE} total={total} onPageChange={setPage} loading={loading}>
        <ColumnTable rows={pageRows} columns={columns} rowKey={(row) => row.period_month} />
      </PaginatedTable>

      <CreditCardExpenseLinesSelectionProvider
        key={selected?.period_month ?? "closed"}
        lines={monthModalLines}
      >
        <Modal
          open={modalOpen}
          onClose={closeModal}
          closeAriaLabel={t("expenses.creditCard.monthModalClose")}
          titleNav={titleNav}
          footer={
            <CreditCardExpenseLinesBulkFooter categories={categories} bigGroups={bigGroups} />
          }
          title={
            selected
              ? t("expenses.creditCard.monthModalTitle", {
                  month: flowPeriodLabel(selected.period_month, periodGranularity),
                })
              : ""
          }
          subtitle={
            selected ? (
              <>
                <span className="mono">{selected.as_of_date}</span>
                {" · "}
                {t("expenses.creditCard.colMonthExpense")}:{" "}
                {formatFlowMoney(selected.gastos_mes, displayUnit)}
                {" · "}
                {t("expenses.creditCard.colMonthExpenseReal")}:{" "}
                {formatFlowMoney(selected.gastos_real_mes, displayUnit)}
                {selected.abonos_mes !== 0 ? (
                  <>
                    {" · "}
                    {t("expenses.creditCard.modalSectionAbonos")}:{" "}
                    {formatFlowMoney(selected.abonos_mes, displayUnit)}
                  </>
                ) : null}
              </>
            ) : null
          }
        >
          {monthLines.error && !monthLines.data ? (
            <p className="error">{t("common.loadFailed")}</p>
          ) : monthLinesLoading ? (
            // The month's lines are not in yet: an empty dimmed body, never the «no lines» copy.
            <Loadable loading />
          ) : (
            <CreditCardExpenseMonthModalSections
              bucket={monthBucket}
              categories={categories}
              bigGroups={bigGroups}
              abonosSumClp={selected?.abonos_mes}
              enableCheckingNotes
            />
          )}
        </Modal>
      </CreditCardExpenseLinesSelectionProvider>
    </>
  );
}
