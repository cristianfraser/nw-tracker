import type { ExpensesSpentMonth } from "../../types";
import { useTranslation } from "../../i18n";
import { formatCurrency } from "../../format";
import { formatYearMonthLabel } from "../../formatDateLabel";
import styles from "./ExpensesSpent.module.css";

/**
 * Week rows every month gets, so calendars side by side line up: a sixth week's days (at most
 * two) fold into the cell above them, split on the diagonal.
 */
const WEEK_ROWS = 5;

/** Monday-first weekday columns: `common.weekdayShort` is Sunday = 0. */
const WEEKDAYS_MONDAY_FIRST = [1, 2, 3, 4, 5, 6, 0] as const;

function weekdayMondayFirst(ymd: string): number {
  const [y, m, d] = ymd.split("-").map(Number);
  return (new Date(Date.UTC(y!, m! - 1, d!)).getUTCDay() + 6) % 7;
}

function daysInMonth(ym: string): number {
  const [y, m] = ym.split("-").map(Number);
  return new Date(Date.UTC(y!, m!, 0)).getUTCDate();
}

/**
 * Month grids (7 columns, Monday first), two by two, oldest first; the top row (the older months)
 * is dimmed, with half-height cells. Every month has five week rows: a sixth week's day shares
 * the cell above it, the earlier day its top-left triangle, the later one the bottom-right. Each
 * day is tinted by its heat level (the server's, one hue: spending only). A month's title picks
 * the month, a day picks the day; days after today are drawn empty.
 */
export function ExpensesCalendar({
  months,
  unit,
  today,
  selectedMonth,
  selectedDay,
  onMonth,
  onDay,
}: {
  /** The months to draw, oldest first. */
  months: readonly ExpensesSpentMonth[];
  unit: string;
  today: string;
  selectedMonth: string;
  selectedDay: string | null;
  onMonth: (ym: string) => void;
  onDay: (ymd: string) => void;
}) {
  const { t } = useTranslation();
  return (
    <div className={styles.calendars}>
      {months.map((month, mi) => {
        const lead = weekdayMondayFirst(`${month.month}-01`);
        const total = daysInMonth(month.month);
        const byDay = new Map(month.days.map((d) => [d.day, d]));
        const onTitle = month.month === selectedMonth && selectedDay == null;
        const dayCell = (n: number, half: string) => {
          const ymd = `${month.month}-${String(n).padStart(2, "0")}`;
          const day = byDay.get(ymd);
          if (!day) {
            return (
              <span key={ymd} className={`${styles.cell} ${styles.cellFuture} ${half}`} aria-hidden="true">
                {n}
              </span>
            );
          }
          const classes = [
            styles.cell,
            half,
            ymd === selectedDay ? styles.cellOn : "",
            ymd === today ? styles.cellToday : "",
          ].join(" ");
          return (
            <button
              key={ymd}
              type="button"
              className={classes}
              data-level={day.level}
              title={`${ymd} · ${formatCurrency(day.total, unit)}`}
              aria-pressed={ymd === selectedDay}
              onClick={() => onDay(ymd)}
            >
              {n}
            </button>
          );
        };
        return (
          <div key={month.month} className={mi < months.length - 2 ? styles.calCompact : undefined}>
            <div className={styles.calTitle}>
              <button
                type="button"
                className={`${styles.calTitleButton} ${onTitle ? styles.calTitleOn : ""}`}
                onClick={() => onMonth(month.month)}
              >
                {formatYearMonthLabel(month.month)}
              </button>
              <span className={styles.mono}>{formatCurrency(month.total, unit)}</span>
            </div>
            <div className={styles.weekdays}>
              {WEEKDAYS_MONDAY_FIRST.map((w) => (
                <span key={w}>{t(`common.weekdayShort.${w}`)}</span>
              ))}
            </div>
            <div className={styles.grid}>
              {Array.from({ length: lead }, (_, i) => (
                <span key={`lead-${i}`} />
              ))}
              {Array.from({ length: Math.min(total, WEEK_ROWS * 7 - lead) }, (_, i) => {
                const n = i + 1;
                // A day of a sixth week shares the cell of its weekday one week earlier.
                const folded = lead + n - 1 + 7 >= WEEK_ROWS * 7 && n + 7 <= total ? n + 7 : null;
                if (folded == null) return dayCell(n, "");
                return (
                  <span key={n} className={styles.cellSplit}>
                    {dayCell(n, styles.halfTop!)}
                    {dayCell(folded, styles.halfBottom!)}
                  </span>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}
