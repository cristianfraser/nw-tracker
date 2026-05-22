import { useCallback, useMemo, useState } from "react";
import { useTranslation } from "../i18n";
import { formatClp } from "../format";
import type {
  CcExpenseCategoryDto,
  FlowCcExpenseLineRow,
  FlowCcExpenseMonthRow,
} from "../types";
import {
  countsTowardGastosMes,
  sumLineAmountsClp,
} from "../ccExpenseLineBuckets";
import { Table } from "./Table";
import { Modal } from "./Modal";
import {
  CreditCardExpenseLinesTable,
  sortCreditCardExpenseLinesByStatement,
} from "./CreditCardExpenseLinesTable";
import { formatYmEs } from "../pages/accountDetail/shared";
import linkStyles from "../pages/accountDetail/CreditCardFacturacionesTable.module.css";

function monthLines(
  lines: readonly FlowCcExpenseLineRow[],
  periodMonth: string
): FlowCcExpenseLineRow[] {
  return lines.filter((ln) => ln.billing_month === periodMonth);
}

export function CreditCardGroupExpensesMonthTable({
  rows,
  lines,
  categories,
  collapsedVisibleRows = 12,
}: {
  rows: readonly FlowCcExpenseMonthRow[];
  lines: readonly FlowCcExpenseLineRow[];
  categories: readonly CcExpenseCategoryDto[];
  collapsedVisibleRows?: number;
}) {
  const { t } = useTranslation();
  const hidden = Math.max(0, rows.length - collapsedVisibleRows);
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

  const monthBucket = useMemo(() => {
    if (!selected) {
      return { gastos: [], abonos: [], excluded: [] };
    }
    const inMonth = monthLines(lines, selected.period_month);
    const gastos = inMonth
      .filter(countsTowardGastosMes)
      .sort(sortCreditCardExpenseLinesByStatement);
    const abonos = inMonth
      .filter((ln) => ln.amount_clp < 0)
      .sort(sortCreditCardExpenseLinesByStatement);
    const excluded = inMonth
      .filter((ln) => ln.amount_clp > 0 && !countsTowardGastosMes(ln))
      .sort(sortCreditCardExpenseLinesByStatement);
    return { gastos, abonos, excluded };
  }, [lines, selected]);

  const gastosSum = useMemo(
    () => sumLineAmountsClp(monthBucket.gastos),
    [monthBucket.gastos]
  );
  const excludedSum = useMemo(
    () => sumLineAmountsClp(monthBucket.excluded),
    [monthBucket.excluded]
  );

  if (rows.length === 0) {
    return <p className="muted">{t("expenses.creditCard.emptyMonths")}</p>;
  }

  return (
    <>
      <Table
        collapsedVisibleRows={collapsedVisibleRows}
        showMoreLabel={t("table.showMoreMonths", { count: hidden })}
        showLessLabel={t("table.showLessMonths")}
        header={
          <thead>
            <tr>
              <th data-sort-key="month" data-sort-type="date">
                {t("accountDetail.monthCloseColumn")}
              </th>
              <th data-sort-key="gastos" data-sort-type="number">
                {t("expenses.creditCard.colMonthExpense")}
              </th>
              <th data-sort-key="gastos_real" data-sort-type="number">
                {t("expenses.creditCard.colMonthExpenseReal")}
              </th>
              <th data-sort-key="cumulative" data-sort-type="number">
                {t("expenses.creditCard.colCumulative")}
              </th>
              <th data-sort-key="lines" data-sort-type="number">
                {t("expenses.creditCard.colLineCount")}
              </th>
            </tr>
          </thead>
        }
      >
        {rows.map((row) => (
          <tr
            key={row.period_month}
            data-sort-month={row.as_of_date}
            data-sort-gastos={row.gastos_mes_clp}
            data-sort-gastos_real={row.gastos_real_mes_clp}
            data-sort-cumulative={row.gastos_acumulado_clp}
            data-sort-lines={row.line_count}
          >
            <td className="mono">
              <button
                type="button"
                className={linkStyles.dateLink}
                onClick={() => openMonth(row)}
              >
                {row.as_of_date} ({formatYmEs(row.period_month)})
              </button>
            </td>
            <td className="mono">{formatClp(row.gastos_mes_clp)}</td>
            <td className="mono muted">{formatClp(row.gastos_real_mes_clp)}</td>
            <td className="mono">{formatClp(row.gastos_acumulado_clp)}</td>
            <td className="mono muted">{row.line_count}</td>
          </tr>
        ))}
      </Table>

      <Modal
        open={modalOpen}
        onClose={closeModal}
        closeAriaLabel={t("expenses.creditCard.monthModalClose")}
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
        {monthBucket.gastos.length === 0 &&
        monthBucket.abonos.length === 0 &&
        monthBucket.excluded.length === 0 ? (
          <p className="muted">{t("expenses.creditCard.monthModalEmpty")}</p>
        ) : (
          <>
            <h3 style={{ fontSize: "1rem", marginBottom: "0.35rem" }}>
              {t("expenses.creditCard.modalSectionGastos")}
              {monthBucket.gastos.length > 0 ? (
                <span className="muted mono" style={{ fontSize: "0.85rem", marginLeft: "0.5rem" }}>
                  {formatClp(gastosSum)}
                </span>
              ) : null}
            </h3>
            <CreditCardExpenseLinesTable
              lines={monthBucket.gastos}
              categories={categories}
              emptyLabel={t("expenses.creditCard.modalSectionEmpty")}
              showCategoryControls
            />

            <h3 style={{ fontSize: "1rem", margin: "1.25rem 0 0.35rem" }}>
              {t("expenses.creditCard.modalSectionAbonos")}
              {monthBucket.abonos.length > 0 ? (
                <span className="muted mono" style={{ fontSize: "0.85rem", marginLeft: "0.5rem" }}>
                  {formatClp(selected?.abonos_mes_clp ?? 0)}
                </span>
              ) : null}
            </h3>
            <CreditCardExpenseLinesTable
              lines={monthBucket.abonos}
              categories={categories}
              emptyLabel={t("expenses.creditCard.modalSectionEmpty")}
              showCategoryControls={false}
            />

            <h3 style={{ fontSize: "1rem", margin: "1.25rem 0 0.35rem" }}>
              {t("expenses.creditCard.modalSectionExcluded")}
              {monthBucket.excluded.length > 0 ? (
                <span className="muted mono" style={{ fontSize: "0.85rem", marginLeft: "0.5rem" }}>
                  {formatClp(excludedSum)}
                </span>
              ) : null}
            </h3>
            <CreditCardExpenseLinesTable
              lines={monthBucket.excluded}
              categories={categories}
              emptyLabel={t("expenses.creditCard.modalSectionEmpty")}
              showCategoryControls
            />
          </>
        )}
      </Modal>
    </>
  );
}
