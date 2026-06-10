import { useCallback, useMemo, useState } from "react";
import { useTranslation } from "../../i18n";
import { formatClp } from "../../format";
import type { CcExpenseBigGroupDto, CcExpenseCategoryDto, FlowCcExpenseLineRow, FlowCcExpenseMonthRow } from "../../types";
import { sumLineAmountsClp } from "../../ccExpenseLineBuckets";
import type { CcInstallmentGastosMode } from "../../ccExpensePeriodMonth";
import { PaginatedTable } from "../ui/PaginatedTable";
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
import { formatYmEs } from "../../pages/accountDetail/shared";
import linkStyles from "../../pages/accountDetail/CreditCardFacturacionesTable.module.css";

function GroupExpensesMonthMobileCard({
  row,
  labels,
  onOpen,
}: {
  row: FlowCcExpenseMonthRow;
  labels: {
    gastos: string;
    gastosReal: string;
    cumulative: string;
    lineCount: string;
  };
  onOpen: (row: FlowCcExpenseMonthRow) => void;
}) {
  const title = (
    <button type="button" className={linkStyles.dateLink} onClick={() => onOpen(row)}>
      {row.as_of_date} ({formatYmEs(row.period_month)})
    </button>
  );

  return (
    <TableMobileCard title={title}>
      <TableMobileCardSection>
        <TableMobileCardRow label={labels.gastos} value={formatClp(row.gastos_mes_clp)} />
        <TableMobileCardRow
          label={labels.gastosReal}
          value={<span className="muted">{formatClp(row.gastos_real_mes_clp)}</span>}
        />
        <TableMobileCardRow label={labels.cumulative} value={formatClp(row.gastos_acumulado_clp)} />
        <TableMobileCardRow
          label={labels.lineCount}
          value={<span className="muted">{row.line_count}</span>}
        />
      </TableMobileCardSection>
    </TableMobileCard>
  );
}

export function GroupExpensesMonthTable({
  rows,
  lines,
  categories,
  bigGroups = [],
  installmentMode,
  collapsedVisibleRows = 12,
}: {
  rows: readonly FlowCcExpenseMonthRow[];
  lines: readonly FlowCcExpenseLineRow[];
  categories: readonly CcExpenseCategoryDto[];
  bigGroups?: readonly CcExpenseBigGroupDto[];
  installmentMode: CcInstallmentGastosMode;
  collapsedVisibleRows?: number;
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

  const purchasesSum = useMemo(
    () => sumLineAmountsClp(monthBucket.purchases),
    [monthBucket.purchases]
  );

  const gastosSum = useMemo(
    () =>
      selected
        ? selected.gastos_mes_clp
        : purchasesSum + sumLineAmountsClp(monthBucket.installments),
    [monthBucket.installments, purchasesSum, selected]
  );

  const pages = useMemo(() => {
    const byYear = new Map<string, FlowCcExpenseMonthRow[]>();
    for (const row of rows) {
      const year = row.period_month.slice(0, 4);
      const bucket = byYear.get(year) ?? [];
      bucket.push(row);
      byYear.set(year, bucket);
    }
    const yearsAsc = [...byYear.keys()].sort((a, b) => Number(a) - Number(b));
    return yearsAsc.map((year, pageNumber) => ({
      pageNumber,
      data: byYear.get(year) ?? [],
    }));
  }, [rows]);

  if (rows.length === 0) {
    return <p className="muted">{t("expenses.creditCard.emptyMonths")}</p>;
  }

  return (
    <>
      <PaginatedTable
        pages={pages}
        collapsedVisibleRows={collapsedVisibleRows}
        showMoreLabel={(hiddenCount) => t("table.showMoreMonths", { count: hiddenCount })}
        showLessLabel={t("table.showLessMonths")}
        tableClassName="table--parallel-mobile"
        getPageLabel={(page) => page.data[0]?.period_month.slice(0, 4) ?? String(page.pageNumber)}
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
        renderBody={(pageRows) => (
          <>
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
                    {row.as_of_date} ({formatYmEs(row.period_month)})
                  </button>
                </td>
                <td className="mono desktop-only">{formatClp(row.gastos_mes_clp)}</td>
                <td className="mono muted desktop-only">{formatClp(row.gastos_real_mes_clp)}</td>
                <td className="mono desktop-only">{formatClp(row.gastos_acumulado_clp)}</td>
                <td className="mono muted desktop-only">{row.line_count}</td>
                <td className="mobile-only">
                  <GroupExpensesMonthMobileCard row={row} labels={mobileLabels} onOpen={openMonth} />
                </td>
              </tr>
            ))}
          </>
        )}
      />

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
              ? t("expenses.creditCard.monthModalTitle", { month: formatYmEs(selected.period_month) })
              : ""
          }
          subtitle={
            selected ? (
              <>
                <span className="mono">{selected.as_of_date}</span>
                {" · "}
                {t("expenses.creditCard.colMonthExpense")}: {formatClp(gastosSum)}
                {" · "}
                {t("expenses.creditCard.colMonthExpenseReal")}: {formatClp(selected.gastos_real_mes_clp)}
                {selected.abonos_mes_clp !== 0 ? (
                  <>
                    {" · "}
                    {t("expenses.creditCard.modalSectionAbonos")}: {formatClp(selected.abonos_mes_clp)}
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
