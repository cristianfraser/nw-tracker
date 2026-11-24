import { useMemo, useState } from "react";
import { Button } from "@crfrsr/ui";
import { PageGridTile } from "../components/layout/PageGridTile";
import { ManualExpenseDialog } from "../components/credit-card/ManualExpenseDialog";
import { useFlowsExpensesSpent, useFlowsExpensesSpentLines, useFlowsExpensesSummary } from "../queries/hooks";
import { BigExpenseGroupsSection } from "../components/credit-card/BigExpenseGroupsSection";
import { CreditCardUnclassifiedExpensesTable } from "../components/credit-card/CreditCardUnclassifiedExpensesTable";
import { CreditCardDepositMatchedExpensesTable } from "../components/credit-card/CreditCardDepositMatchedExpensesTable";
import { CreditCardFacturadoFinancingManager } from "../components/credit-card/CreditCardFacturadoFinancingManager";
import { AdditionalCardsSection } from "../components/credit-card/AdditionalCardsSection";
import { ExpensesSpentChart } from "../components/expenses/ExpensesSpentChart";
import { ExpensesCalendar } from "../components/expenses/ExpensesCalendar";
import { ExpensesSpentList } from "../components/expenses/ExpensesSpentList";
import { ExpensesMonthMatrix } from "../components/expenses/ExpensesMonthMatrix";
import styles from "../components/expenses/ExpensesSpent.module.css";
import { useDisplayPreferences } from "../context/DisplayPreferencesContext";
import { useSurfacePrefs } from "../surfaceDisplayPrefs";
import { ccExpenseCategoryLabel, useTranslation } from "../i18n";
import { formatCurrency } from "../format";
import { useCcInstallmentGastosMode } from "../useCcInstallmentGastosMode";
import { useExpensesIncludePreTax } from "../useExpensesIncludePreTax";
import { useCcExpenseCategoryLevel } from "../useCcExpenseCategoryLevel";
import { useCcExpenseExcludedBigGroups } from "../useCcExpenseExcludedBigGroups";
import { queryLoadError, queryShowsLoading } from "../queries/pageShapeReady";
import { loadableClass } from "../components/ui/Loadable";
import { EXPENSES_SPENT_RANGES, type ExpensesSpentRange, type FlowCcExpenseLineRow } from "../types";

function asSpentRange(r: string): ExpensesSpentRange {
  return (EXPENSES_SPENT_RANGES as readonly string[]).includes(r) ? (r as ExpensesSpentRange) : "6m";
}

/** What the list shows: a month, or one day of it; optionally one category. */
type Selection = { month: string | null; day: string | null; category: string | null };

/**
 * Expenses page, by the day each expense was spent: the month-to-date chart stacked by category
 * with its day strip, the category pills, the calendar beside the selection's lines, the month ×
 * category matrix; then big groups, additional cards and the lists that wait on the user. One
 * selection (month, day, category) drives the chart band, the calendar, the list and the matrix.
 */
export function ExpensesPage() {
  const { t } = useTranslation();
  const { displayUnit } = useDisplayPreferences();
  const [manualOpen, setManualOpen] = useState(false);
  const [manualLine, setManualLine] = useState<FlowCcExpenseLineRow | null>(null);
  const chartPrefs = useSurfacePrefs("flows.expenses.spent", "day", "6m");
  const range = asSpentRange(chartPrefs.range);
  const { installmentMode, setInstallmentMode } = useCcInstallmentGastosMode();
  const { categoryLevel, setCategoryLevel } = useCcExpenseCategoryLevel();
  const { includePreTax, setIncludePreTax } = useExpensesIncludePreTax();

  const summary = useFlowsExpensesSummary(displayUnit);
  const activeBigGroups = useMemo(() => summary.data?.active_big_group_slugs ?? [], [summary.data]);
  const { excludedBigGroups, isExcluded, toggleExcluded } = useCcExpenseExcludedBigGroups(activeBigGroups);
  const excludedBigGroupList = useMemo(() => [...excludedBigGroups], [excludedBigGroups]);

  const params = useMemo(
    () => ({
      unit: displayUnit,
      mode: installmentMode,
      level: categoryLevel,
      range,
      excludedBigGroups: excludedBigGroupList,
      includePreTax,
    }),
    [displayUnit, installmentMode, categoryLevel, range, excludedBigGroupList, includePreTax]
  );
  // The default exclusion is every big group the lines carry: wait for the summary before asking.
  const spent = useFlowsExpensesSpent(params, summary.data != null);
  const data = spent.data;
  const monthKeys = useMemo(() => (data?.months ?? []).map((m) => m.month), [data]);
  const selectableMonths = useMemo(() => new Set(monthKeys), [monthKeys]);

  const [sel, setSel] = useState<Selection>({ month: null, day: null, category: null });
  // No month picked yet (or one the payload no longer has): the current month.
  const month = sel.month != null && selectableMonths.has(sel.month) ? sel.month : (monthKeys[monthKeys.length - 1] ?? "");
  const day = sel.day != null && sel.day.startsWith(month) ? sel.day : null;
  // A picked category holds only while the payload is the current level's (a held payload of the
  // other level would still list it and send the lines request a category the level lacks).
  const category =
    sel.category != null && data?.level === categoryLevel && data.category_slugs.includes(sel.category)
      ? sel.category
      : null;

  const lines = useFlowsExpensesSpentLines(params, { month, day, category }, summary.data != null && month !== "");

  const loadError = queryLoadError(summary) ?? queryLoadError(spent) ?? queryLoadError(lines);
  if (loadError) {
    return <p className="error">{loadError instanceof Error ? loadError.message : t("common.loadFailed")}</p>;
  }

  const spentLoading = queryShowsLoading(spent);
  const linesLoading = queryShowsLoading(lines);
  const categories = summary.data?.categories ?? [];
  const unit = data?.unit ?? displayUnit;
  const selectedMonth = data?.months.find((m) => m.month === month);
  const at = monthKeys.indexOf(month);
  // The calendar: the selected month and the three before it, two by two.
  const calendarMonths = at < 0 ? [] : (data?.months ?? []).slice(Math.max(0, at - 3), at + 1);

  const pickMonth = (ym: string) => setSel((s) => ({ ...s, month: ym, day: null }));
  const pickDay = (ymd: string) => setSel((s) => ({ ...s, month: ymd.slice(0, 7), day: ymd }));
  const pickCategory = (slug: string) => setSel((s) => ({ ...s, month, category: s.category === slug ? null : slug }));
  const dayMode = () => {
    if (day != null) return;
    // The latest day of the month that spent something, else its last day so far.
    const days = selectedMonth?.days ?? [];
    const pick = [...days].reverse().find((d) => d.total > 0) ?? days[days.length - 1];
    if (pick) pickDay(pick.day);
  };

  const toggle = (on: boolean) => `${styles.toggle} ${on ? styles.toggleOn : ""}`;

  return (
    <>
      <div className={styles.titleRow}>
        <h2 className="flow-section-title">{t("sidebar.flowsExpenses")}</h2>
        <div className={styles.toggles}>
          <span className={styles.toggleGroup}>
            <button type="button" className={toggle(installmentMode === "split")} onClick={() => setInstallmentMode("split")}>
              {t("expenses.creditCard.installmentModeSplit")}
            </button>
            <button type="button" className={toggle(installmentMode === "total")} onClick={() => setInstallmentMode("total")}>
              {t("expenses.creditCard.installmentModeTotal")}
            </button>
          </span>
          <span className={styles.toggleGroup}>
            <button type="button" className={toggle(categoryLevel === "category")} onClick={() => setCategoryLevel("category")}>
              {t("expenses.creditCard.categoryLevelCategory")}
            </button>
            <button type="button" className={toggle(categoryLevel === "subcategory")} onClick={() => setCategoryLevel("subcategory")}>
              {t("expenses.creditCard.categoryLevelSubcategory")}
            </button>
          </span>
          <button
            type="button"
            className={toggle(includePreTax)}
            title={t("expenses.creditCard.includePreTaxHint")}
            aria-pressed={includePreTax}
            onClick={() => setIncludePreTax(!includePreTax)}
          >
            {t("expenses.creditCard.includePreTax")}
          </button>
          <Button variant="secondary" onClick={() => setManualOpen(true)}>
            {t("expenses.creditCard.manualExpense.add")}
          </Button>
          <CreditCardFacturadoFinancingManager />
        </div>
      </div>
      <ManualExpenseDialog open={manualOpen} expense={null} categories={categories} onClose={() => setManualOpen(false)} />
      <ManualExpenseDialog
        open={manualLine != null}
        expense={manualLine}
        categories={categories}
        onClose={() => setManualLine(null)}
      />

      <PageGridTile id="spent-chart">
        <ExpensesSpentChart
          data={data}
          categories={categories}
          range={range}
          onRangeChange={(r) => chartPrefs.setRange(r)}
          selectedMonth={month}
          selectedCategory={category}
          selectableMonths={selectableMonths}
          onMonth={pickMonth}
          onDay={pickDay}
          loading={spentLoading}
        />
      </PageGridTile>

      <PageGridTile id="spent-categories">
        <div className={styles.pills}>
          {(data?.category_slugs ?? []).map((slug, k) => {
            const value = selectedMonth?.cells[k]?.value ?? 0;
            const on = slug === category;
            const color = categories.find((c) => c.slug === slug)?.chart_color;
            return (
              <button
                key={slug}
                type="button"
                className={`${styles.pill} ${on ? styles.pillOn : ""} ${value === 0 && !on ? styles.pillDim : ""}`}
                aria-pressed={on}
                onClick={() => pickCategory(slug)}
              >
                <span className={styles.dot} style={{ background: color }} />
                {ccExpenseCategoryLabel(slug)}
                <span className={`${styles.pillAmount} ${styles.mono}`}>{formatCurrency(value, unit)}</span>
              </button>
            );
          })}
          {category ? (
            <button type="button" className={styles.linkButton} onClick={() => setSel((s) => ({ ...s, category: null }))}>
              {t("expenses.spent.allCategories")}
            </button>
          ) : null}
        </div>
      </PageGridTile>

      <PageGridTile id="spent-calendar">
        <div className={styles.calendarTile}>
          <div className={styles.calendarRow}>
            <div className={loadableClass(spentLoading)}>
              <ExpensesCalendar
                months={calendarMonths}
                unit={unit}
                today={data?.today ?? ""}
                selectedMonth={month}
                selectedDay={day}
                onMonth={pickMonth}
                onDay={pickDay}
              />
            </div>
            <div className={styles.listColumn}>
            <ExpensesSpentList
              data={lines.data}
              months={monthKeys}
              month={month}
              day={day}
              category={category}
              categories={categories}
              bigGroups={summary.data?.big_groups ?? []}
              onMonth={pickMonth}
              onDayMode={dayMode}
              onWholeMonth={() => setSel((s) => ({ ...s, day: null }))}
              onClearCategory={() => setSel((s) => ({ ...s, category: null }))}
              onEditManual={setManualLine}
              loading={linesLoading}
            />
            </div>
          </div>
        </div>
      </PageGridTile>

      <PageGridTile id="spent-matrix">
        <ExpensesMonthMatrix
          data={data}
          categories={categories}
          selectedMonth={month}
          selectedCategory={category}
          onMonth={pickMonth}
          onCategory={pickCategory}
          onCell={(ym, slug) => setSel({ month: ym, day: null, category: slug })}
          loading={spentLoading}
        />
      </PageGridTile>

      <BigExpenseGroupsSection
        includePreTax={includePreTax}
        categories={categories}
        bigGroups={summary.data?.big_groups ?? []}
        usage={data?.big_group_usage ?? []}
        unit={unit}
        isExcluded={isExcluded}
        toggleExcluded={toggleExcluded}
        loading={spentLoading}
      />

      <AdditionalCardsSection summary={summary.data?.additional_cards} displayUnit={displayUnit} loading={summary.data == null} />

      <CreditCardUnclassifiedExpensesTable includePreTax={includePreTax} />

      <CreditCardDepositMatchedExpensesTable includePreTax={includePreTax} />
    </>
  );
}
