import type { CcExpenseCategoryDto, FlowsExpensesSpentResponse } from "../../types";
import { ccExpenseCategoryLabel, useTranslation } from "../../i18n";
import { formatCurrency } from "../../format";
import { formatYearMonthLabel } from "../../formatDateLabel";
import { loadableClass } from "../ui/Loadable";
import styles from "./ExpensesSpent.module.css";

/**
 * The class that hides a month column on a narrow matrix, by its rank — the selected month first
 * (never hidden), then the others newest first. Each column needs about 120px beside the ~200px of
 * category names, so rank r shows from 200 + (r + 1) × 120 px (container queries in the CSS).
 */
const HIDE_BY_RANK = [
  "",
  styles.hideRank1,
  styles.hideRank2,
  styles.hideRank3,
  styles.hideRank4,
  styles.hideRank5,
] as const;

function narrowClass(rank: number): string {
  return HIDE_BY_RANK[Math.min(rank, HIDE_BY_RANK.length - 1)] ?? "";
}

/**
 * Month × category: each cell's amount under a bar on one scale for the whole matrix (the server's),
 * then the month's gasto (its own bars), total real and line count. A month header picks the month,
 * a category name the category, a cell both.
 */
export function ExpensesMonthMatrix({
  data,
  categories,
  selectedMonth,
  selectedCategory,
  onMonth,
  onCategory,
  onCell,
  loading,
}: {
  data: FlowsExpensesSpentResponse | undefined;
  categories: readonly CcExpenseCategoryDto[];
  selectedMonth: string;
  selectedCategory: string | null;
  onMonth: (ym: string) => void;
  onCategory: (slug: string) => void;
  onCell: (ym: string, slug: string) => void;
  loading: boolean;
}) {
  const { t } = useTranslation();
  const unit = data?.unit ?? "clp";
  const months = data?.months ?? [];
  const slugs = data?.category_slugs ?? [];
  const colorBySlug = new Map(categories.map((c) => [c.slug, c.chart_color]));
  const ranked = [selectedMonth, ...months.map((m) => m.month).reverse().filter((ym) => ym !== selectedMonth)];
  const colClass = (ym: string) =>
    ym === selectedMonth ? styles.colOn : narrowClass(ranked.indexOf(ym));

  return (
    <div className={`${styles.matrixWrap} ${loadableClass(loading)}`}>
      <div className={`chart-panel-title-row ${styles.titleRow}`}>
        <h3 className="muted">{t("expenses.spent.matrixTitle")}</h3>
      </div>
      <table className={`${styles.matrix} ${styles.mono}`}>
        <thead>
          <tr>
            <th />
            {months.map((m) => (
              <th key={m.month} className={colClass(m.month)}>
                <button type="button" className={styles.colButton} onClick={() => onMonth(m.month)}>
                  {formatYearMonthLabel(m.month)}
                </button>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {slugs.map((slug, k) => {
            const color = colorBySlug.get(slug) ?? "var(--muted)";
            const dim = selectedCategory != null && selectedCategory !== slug;
            return (
              <tr key={slug} className={dim ? styles.rowDim : undefined}>
                <td>
                  <button type="button" className={styles.rowLabel} onClick={() => onCategory(slug)}>
                    <span className={styles.dot} style={{ background: color }} />
                    {ccExpenseCategoryLabel(slug)}
                  </button>
                </td>
                {months.map((m) => {
                  const cell = m.cells[k]!;
                  return (
                    <td key={m.month} className={colClass(m.month)}>
                      <button type="button" className={styles.cellButton} onClick={() => onCell(m.month, slug)}>
                        <span className={styles.barSlot}>
                          <span className={styles.barFill} style={{ width: `${cell.bar * 100}%`, background: color }} />
                        </span>
                        {formatCurrency(cell.value, unit)}
                      </button>
                    </td>
                  );
                })}
              </tr>
            );
          })}
          <tr className={styles.totalRow}>
            <td>{t("expenses.creditCard.colMonthExpense")}</td>
            {months.map((m) => (
              <td key={m.month} className={colClass(m.month)}>
                <button type="button" className={styles.cellButton} onClick={() => onMonth(m.month)}>
                  <span className={styles.barSlot}>
                    <span className={styles.barFill} style={{ width: `${m.total_bar * 100}%`, background: "var(--muted)" }} />
                  </span>
                  {formatCurrency(m.total, unit)}
                </button>
              </td>
            ))}
          </tr>
          <tr className={styles.quietRow}>
            <td>{t("expenses.creditCard.colMonthExpenseReal")}</td>
            {months.map((m) => (
              <td key={m.month} className={colClass(m.month)}>
                {formatCurrency(m.total_real, unit)}
              </td>
            ))}
          </tr>
          <tr className={styles.quietRow}>
            <td>{t("expenses.creditCard.colLineCount")}</td>
            {months.map((m) => (
              <td key={m.month} className={colClass(m.month)}>
                {m.line_count}
              </td>
            ))}
          </tr>
        </tbody>
      </table>
    </div>
  );
}
