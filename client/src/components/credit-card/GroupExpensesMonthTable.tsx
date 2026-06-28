import { useCallback, useMemo, useState } from "react";
import { useTranslation } from "../../i18n";
import { flowPeriodLabel, formatFlowMoney, type FlowChartGranularity } from "../../flowsDisplay";
import type { DisplayUnit } from "../../queries/keys";
import type { CcExpenseBigGroupDto, CcExpenseCategoryDto, FlowCcExpenseLineRow, FlowCcExpenseMonthRow } from "../../types";
import type { CcInstallmentGastosMode } from "../../ccExpensePeriodMonth";
import { PaginatedTable, useClientPagination } from "../ui/PaginatedTable";
import { Table } from "../ui/Table";
import { Modal } from "../ui/Modal";
import {
  buildCreditCardExpenseMonthBucket,
  CreditCardExpenseMonthModalSections,
  emptyCreditCardExpenseMonthBucket,
} from "./CreditCardExpenseMonthModalSections";
import {
  CreditCardExpenseLinesBulkFooter,
  CreditCardExpenseLinesSelectionProvider,
} from "./CreditCardExpenseLinesSelection";
import {
  TableMobileCard,
  TableMobileCardRow,
  TableMobileCardSection,
} from "../ui/TableMobileCard";
import linkStyles from "../../pages/accountDetail/CreditCardFacturacionesTable.module.css";

function GroupExpensesMonthMobileCard({
  row,
  labels,
  onOpen,
  displayUnit,
  periodGranularity,
}: {
  row: FlowCcExpenseMonthRow;
  labels: {
    gastos: string;
    gastosReal: string;
    cumulative: string;
    lineCount: string;
  };
  onOpen: (row: FlowCcExpenseMonthRow) => void;
  displayUnit: DisplayUnit;
  periodGranularity: FlowChartGranularity;
}) {
  const title = (
    <button type="button" className={linkStyles.dateLink} onClick={() => onOpen(row)}>
      {row.as_of_date} ({flowPeriodLabel(row.period_month, periodGranularity)})
    </button>
  );

  return (
    <TableMobileCard title={title}>
      <TableMobileCardSection>
        <TableMobileCardRow
          label={labels.gastos}
          value={formatFlowMoney(row.gastos_mes_clp, displayUnit)}
        />
        <TableMobileCardRow
          label={labels.gastosReal}
          value={
            <span className="muted">{formatFlowMoney(row.gastos_real_mes_clp, displayUnit)}</span>
          }
        />
        <TableMobileCardRow
          label={labels.cumulative}
          value={formatFlowMoney(row.gastos_acumulado_clp, displayUnit)}
        />
        <TableMobileCardRow
          label={labels.lineCount}
          value={<span className="muted">{row.line_count}</span>}
        />
      </TableMobileCardSection>
    </TableMobileCard>
  );
}

const PAGE_SIZE = 12;

export function GroupExpensesMonthTable({
  rows,
  lines,
  categories,
  bigGroups = [],
  installmentMode,
  displayUnit = "clp",
  periodGranularity = "month",
}: {
  rows: readonly FlowCcExpenseMonthRow[];
  lines: readonly FlowCcExpenseLineRow[];
  categories: readonly CcExpenseCategoryDto[];
  bigGroups?: readonly CcExpenseBigGroupDto[];
  installmentMode: CcInstallmentGastosMode;
  displayUnit?: DisplayUnit;
  periodGranularity?: FlowChartGranularity;
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

  const mobileLabels = {
    gastos: t("expenses.creditCard.colMonthExpense"),
    gastosReal: t("expenses.creditCard.colMonthExpenseReal"),
    cumulative: t("expenses.creditCard.colCumulative"),
    lineCount: t("expenses.creditCard.colLineCount"),
  };

  const monthBucket = useMemo(() => {
    if (!selected) return emptyCreditCardExpenseMonthBucket();
    return buildCreditCardExpenseMonthBucket(lines, selected.period_month, installmentMode);
  }, [lines, selected, installmentMode]);

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

  const { page, setPage, pageRows, total } = useClientPagination(sortedRows, PAGE_SIZE);

  if (rows.length === 0) {
    return <p className="muted">{t("expenses.creditCard.emptyMonths")}</p>;
  }

  return (
    <>
      <PaginatedTable page={page} pageSize={PAGE_SIZE} total={total} onPageChange={setPage}>
        <Table
          tableClassName="table--parallel-mobile"
          header={
            <thead>
              <tr>
                <th className="desktop-only" data-sort-key="month" data-sort-type="date">
                  {t("accountDetail.monthCloseColumn")}
                </th>
                <th className="desktop-only" data-sort-key="gastos" data-sort-type="number">
                  {t("expenses.creditCard.colMonthExpense")}
                </th>
                <th className="desktop-only" data-sort-key="gastos_real" data-sort-type="number">
                  {t("expenses.creditCard.colMonthExpenseReal")}
                </th>
                <th className="desktop-only" data-sort-key="cumulative" data-sort-type="number">
                  {t("expenses.creditCard.colCumulative")}
                </th>
                <th className="desktop-only" data-sort-key="lines" data-sort-type="number">
                  {t("expenses.creditCard.colLineCount")}
                </th>
                <th className="mobile-only" aria-hidden="true" />
              </tr>
            </thead>
          }
        >
          {pageRows.map((row) => (
            <tr
              key={row.period_month}
              data-sort-month={row.as_of_date}
              data-sort-gastos={row.gastos_mes_clp}
              data-sort-gastos_real={row.gastos_real_mes_clp}
              data-sort-cumulative={row.gastos_acumulado_clp}
              data-sort-lines={row.line_count}
            >
              <td className="mono desktop-only">
                <button
                  type="button"
                  className={linkStyles.dateLink}
                  onClick={() => openMonth(row)}
                >
                  {row.as_of_date} ({flowPeriodLabel(row.period_month, periodGranularity)})
                </button>
              </td>
              <td className="mono desktop-only">
                {formatFlowMoney(row.gastos_mes_clp, displayUnit)}
              </td>
              <td className="mono muted desktop-only">
                {formatFlowMoney(row.gastos_real_mes_clp, displayUnit)}
              </td>
              <td className="mono desktop-only">
                {formatFlowMoney(row.gastos_acumulado_clp, displayUnit)}
              </td>
              <td className="mono muted desktop-only">{row.line_count}</td>
              <td className="mobile-only">
                <GroupExpensesMonthMobileCard
                  row={row}
                  labels={mobileLabels}
                  onOpen={openMonth}
                  displayUnit={displayUnit}
                  periodGranularity={periodGranularity}
                />
              </td>
            </tr>
          ))}
        </Table>
      </PaginatedTable>

      <CreditCardExpenseLinesSelectionProvider
        key={selected?.period_month ?? "closed"}
        lines={monthModalLines}
      >
        <Modal
          open={modalOpen}
          onClose={closeModal}
          closeAriaLabel={t("expenses.creditCard.monthModalClose")}
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
                {formatFlowMoney(selected.gastos_mes_clp, displayUnit)}
                {" · "}
                {t("expenses.creditCard.colMonthExpenseReal")}:{" "}
                {formatFlowMoney(selected.gastos_real_mes_clp, displayUnit)}
                {selected.abonos_mes_clp !== 0 ? (
                  <>
                    {" · "}
                    {t("expenses.creditCard.modalSectionAbonos")}:{" "}
                    {formatFlowMoney(selected.abonos_mes_clp, displayUnit)}
                  </>
                ) : null}
              </>
            ) : null
          }
        >
          <CreditCardExpenseMonthModalSections
            bucket={monthBucket}
            categories={categories}
            bigGroups={bigGroups}
            abonosSumClp={selected?.abonos_mes_clp}
            enableCheckingNotes
          />
        </Modal>
      </CreditCardExpenseLinesSelectionProvider>
    </>
  );
}
