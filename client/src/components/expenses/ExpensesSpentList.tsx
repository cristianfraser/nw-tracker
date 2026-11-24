import { useMemo } from "react";
import type { CcExpenseCategoryDto, FlowCcExpenseLineRow, FlowsExpensesSpentLinesResponse } from "../../types";
import { ccExpenseCategoryLabel, useTranslation } from "../../i18n";
import { formatCurrency } from "../../format";
import { formatYearMonthLabel } from "../../formatDateLabel";
import { CreditCardExpenseLinesTable, type ExpenseLinesSort } from "../credit-card/CreditCardExpenseLinesTable";
import { loadableClass } from "../ui/Loadable";
import styles from "./ExpensesSpent.module.css";

const NEWEST_FIRST: ExpenseLinesSort = { key: "date", direction: "desc" };

/**
 * The lines of the selection (a month, or one day of it; optionally one category): a header with
 * the «día · mes» switch, the month stepper, the category chip, count and total; then the lines,
 * one flat list in the table's sort (newest day first by default).
 */
export function ExpensesSpentList({
  data,
  months,
  month,
  day,
  category,
  categories,
  bigGroups,
  onMonth,
  onDayMode,
  onWholeMonth,
  onClearCategory,
  onEditManual,
  loading,
}: {
  data: FlowsExpensesSpentLinesResponse | undefined;
  /** The months the stepper walks, oldest first. */
  months: readonly string[];
  month: string;
  day: string | null;
  category: string | null;
  categories: readonly CcExpenseCategoryDto[];
  bigGroups: FlowsExpensesSpentLinesResponse["big_groups"];
  onMonth: (ym: string) => void;
  /** «día» pressed while the whole month shows. */
  onDayMode: () => void;
  onWholeMonth: () => void;
  onClearCategory: () => void;
  onEditManual: (line: FlowCcExpenseLineRow) => void;
  loading: boolean;
}) {
  const { t } = useTranslation();
  const unit = data?.unit ?? "clp";
  const at = months.indexOf(month);
  const color = categories.find((c) => c.slug === category)?.chart_color;

  // Each line with the day it counts on (a cuota's statement day, not its purchase date): the
  // row shows it and the date sort reads it.
  const { lines, dateOf } = useMemo(() => {
    const dayByLine = new Map<FlowCcExpenseLineRow, string>();
    for (const d of data?.days ?? []) for (const line of d.lines) dayByLine.set(line, d.day);
    return { lines: [...dayByLine.keys()], dateOf: (line: FlowCcExpenseLineRow) => dayByLine.get(line)! };
  }, [data]);

  const toggle = (on: boolean) => `${styles.toggle} ${on ? styles.toggleOn : ""}`;

  return (
    <div className={`${styles.listPane} ${loadableClass(loading)}`}>
      <div className={styles.listHead}>
        <span className={styles.stepper}>
          <button
            type="button"
            className={styles.stepButton}
            disabled={at <= 0}
            aria-label={t("expenses.spent.prevMonth")}
            onClick={() => onMonth(months[at - 1]!)}
          >
            ‹
          </button>
          <span className={`${styles.listTitle} ${day ? styles.mono : ""}`}>{day ?? formatYearMonthLabel(month)}</span>
          <button
            type="button"
            className={styles.stepButton}
            disabled={at < 0 || at >= months.length - 1}
            aria-label={t("expenses.spent.nextMonth")}
            onClick={() => onMonth(months[at + 1]!)}
          >
            ›
          </button>
        </span>
        <span className={styles.toggleGroup}>
          <button type="button" className={toggle(day != null)} aria-pressed={day != null} onClick={onDayMode}>
            {t("expenses.spent.modeDay")}
          </button>
          <button type="button" className={toggle(day == null)} aria-pressed={day == null} onClick={onWholeMonth}>
            {t("expenses.spent.modeMonth")}
          </button>
        </span>
        {category ? (
          <span className={styles.chip}>
            <span className={styles.dot} style={{ background: color }} />
            {ccExpenseCategoryLabel(category)}
            <button type="button" className={styles.chipX} aria-label={t("expenses.spent.clearCategory")} onClick={onClearCategory}>
              ×
            </button>
          </span>
        ) : null}
        <span className="muted">{t("expenses.spent.lineCount", { count: data?.line_count ?? 0 })}</span>
        <span className={`${styles.listTotal} ${styles.mono}`}>{formatCurrency(data?.total ?? 0, unit)}</span>
      </div>
      <div className={styles.listScroll}>
        <CreditCardExpenseLinesTable
          lines={lines}
          categories={categories}
          bigGroups={bigGroups}
          showBigGroupControls
          enableCheckingNotes
          onEditManual={onEditManual}
          emptyLabel={t("expenses.spent.empty")}
          hideOrigin
          hideDate={day != null}
          defaultSort={NEWEST_FIRST}
          dateOf={dateOf}
          loading={loading && data == null}
        />
      </div>
    </div>
  );
}
