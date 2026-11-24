import { useMemo } from "react";
import type { CcExpenseCategoryDto, ExpensesSpentRange, FlowsExpensesSpentResponse } from "../../types";
import { EXPENSES_SPENT_RANGES } from "../../types";
import { useTranslation } from "../../i18n";
import { formatCurrency } from "../../format";
import { formatMonthShortLabel } from "../../formatDateLabel";
import { loadableClass } from "../ui/Loadable";
import styles from "./ExpensesSpent.module.css";

const W = 1000;
const H = 210;

const RANGE_LABEL_KEYS: Record<ExpensesSpentRange, string> = {
  "90d": "surfaceControls.shortRange.90d",
  "1y": "surfaceControls.shortRange.1y",
  "5y": "surfaceControls.shortRange.5y",
  total: "surfaceControls.shortRange.total",
};

/** A day's heat level as the strip's opacity (0 draws nothing). */
const LEVEL_OPACITY = [0, 0.25, 0.45, 0.7, 1] as const;

/**
 * The month-to-date chart: each month climbs from 0, stacked by category (the server's running
 * sums), the selected month on a faint band, the other categories dimmed while one is picked; the
 * day strip under it on the same x-axis; each year's average monthly gasto a dashed level over its
 * days; month labels pick a month, strip cells a day.
 */
export function ExpensesSpentChart({
  data,
  categories,
  range,
  onRangeChange,
  selectedMonth,
  selectedCategory,
  selectableMonths,
  onMonth,
  onDay,
  loading,
}: {
  data: FlowsExpensesSpentResponse | undefined;
  categories: readonly CcExpenseCategoryDto[];
  range: ExpensesSpentRange;
  onRangeChange: (r: ExpensesSpentRange) => void;
  selectedMonth: string;
  selectedCategory: string | null;
  /** Months that can be picked (the payload's months). */
  selectableMonths: ReadonlySet<string>;
  onMonth: (ym: string) => void;
  onDay: (ymd: string) => void;
  loading: boolean;
}) {
  const { t } = useTranslation();
  const unit = data?.unit ?? "clp";
  const chart = useMemo(() => data?.chart ?? [], [data]);
  const slugs = useMemo(() => data?.category_slugs ?? [], [data]);
  const yearAverages = useMemo(() => data?.year_averages ?? [], [data]);
  const colorBySlug = useMemo(() => new Map(categories.map((c) => [c.slug, c.chart_color])), [categories]);

  // Geometry (raw numbers only; every label is formatted at render).
  const geometry = useMemo(() => {
    const n = chart.length;
    if (n === 0) return null;
    let maxUp = 0;
    let maxDown = 0;
    for (const d of chart) {
      let up = 0;
      let down = 0;
      for (const v of d.stacks) {
        if (v >= 0) up += v;
        else down += v;
      }
      maxUp = Math.max(maxUp, up);
      maxDown = Math.min(maxDown, down);
    }
    for (const a of yearAverages) maxUp = Math.max(maxUp, a.avg);
    const span = maxUp - maxDown || 1;
    const x = (i: number) => (n === 1 ? W / 2 : (i / (n - 1)) * W);
    const y = (v: number) => ((maxUp - v) / span) * H;
    // Month starts inside the range (first day of each month, or the range's first day).
    const months: { ym: string; from: number; to: number }[] = [];
    chart.forEach((d, i) => {
      const ym = d.day.slice(0, 7);
      const last = months[months.length - 1];
      if (!last || last.ym !== ym) months.push({ ym, from: i, to: i });
      else last.to = i;
    });
    // Each month is its own closed area (it ends on its last day and the next one starts from 0,
    // like the dashboard's YTD areas): one band per month and category, upper edge = running sum
    // through the category, lower = through the previous ones.
    const bands = months.flatMap((m) =>
      slugs.map((slug, k) => {
        const upper: string[] = [];
        const lower: string[] = [];
        for (let i = m.from; i <= m.to; i++) {
          const d = chart[i]!;
          let base = 0;
          for (let j = 0; j < k; j++) {
            const v = d.stacks[j]!;
            if ((v >= 0) === (d.stacks[k]! >= 0)) base += v;
          }
          upper.push(`${x(i).toFixed(2)},${y(base + d.stacks[k]!).toFixed(2)}`);
          lower.push(`${x(i).toFixed(2)},${y(base).toFixed(2)}`);
        }
        return { key: `${m.ym}|${slug}`, slug, points: [...upper, ...lower.reverse()].join(" ") };
      })
    );
    const tops = months.map((m) => {
      const pts: string[] = [];
      for (let i = m.from; i <= m.to; i++) {
        const up = chart[i]!.stacks.reduce((a, v) => a + (v > 0 ? v : 0), 0);
        pts.push(`${x(i).toFixed(2)},${y(up).toFixed(2)}`);
      }
      return { ym: m.ym, points: pts.join(" ") };
    });
    // Each year's average monthly gasto: a flat segment over the year's days on the chart.
    const averages = yearAverages.flatMap((a) => {
      const from = chart.findIndex((d) => d.day.startsWith(a.year));
      if (from < 0) return [];
      let to = from;
      while (to + 1 < n && chart[to + 1]!.day.startsWith(a.year)) to++;
      return [{ ...a, x1: x(from), x2: x(to), yv: y(a.avg) }];
    });
    const lastUp = chart[n - 1]!.stacks.reduce((a, v) => a + (v > 0 ? v : 0), 0);
    return { x, y, bands, tops, months, averages, endY: y(lastUp), zeroY: y(0), n };
  }, [chart, slugs, yearAverages]);

  // Month labels thin out on long ranges: every k-th month, January phased.
  const labelStride = useMemo(() => {
    const count = geometry?.months.length ?? 0;
    return count <= 13 ? 1 : count <= 26 ? 3 : count <= 40 ? 4 : count <= 80 ? 6 : 12;
  }, [geometry]);

  const pct = (xVal: number) => `${(xVal / W) * 100}%`;
  const last = chart[chart.length - 1];

  return (
    <div className={`${styles.chartFrame} ${loadableClass(loading)}`}>
      <div className={`chart-panel-title-row ${styles.titleRow}`}>
        <h3 className="muted">{t("expenses.spent.chartTitle")}</h3>
        {/* The basis: the Flows overview and the card pages total by month billed. */}
        <span className={styles.basis}>{t("expenses.spent.basis")}</span>
        <span className={styles.toggleGroup}>
          {EXPENSES_SPENT_RANGES.map((r) => (
            <button
              key={r}
              type="button"
              className={`${styles.toggle} ${styles.mono} ${r === range ? styles.toggleOn : ""}`}
              aria-pressed={r === range}
              onClick={() => onRangeChange(r)}
            >
              {t(RANGE_LABEL_KEYS[r])}
            </button>
          ))}
        </span>
      </div>
      <div className={styles.plot}>
      <div className={styles.chartBox}>
        <svg
          className={styles.chartSvg}
          viewBox={`0 0 ${W} ${H}`}
          preserveAspectRatio="none"
          role="img"
          aria-label={t("expenses.spent.chartAria")}
        >
          {geometry?.months.map((m) => {
            if (m.ym !== selectedMonth) return null;
            const x0 = geometry.x(m.from);
            const x1 = geometry.x(m.to);
            return <rect key={m.ym} className={styles.monthBandOn} x={x0} y={0} width={Math.max(1, x1 - x0)} height={H} />;
          })}
          {geometry?.months.slice(1).map((m) => (
            <line key={m.ym} className={styles.hairline} x1={geometry.x(m.from)} x2={geometry.x(m.from)} y1={0} y2={H} />
          ))}
          {geometry?.bands.map((b) => (
            <polygon
              key={b.key}
              points={b.points}
              fill={colorBySlug.get(b.slug) ?? "var(--muted)"}
              fillOpacity={selectedCategory == null ? 0.55 : b.slug === selectedCategory ? 0.9 : 0.12}
              stroke="none"
            />
          ))}
          {geometry?.tops.map((t) => <polyline key={t.ym} className={styles.topEdge} points={t.points} />)}
          {geometry?.averages.map((a) => (
            <line key={a.year} className={styles.yearAverage} x1={a.x1} x2={a.x2} y1={a.yv} y2={a.yv}>
              <title>{t("expenses.spent.yearAverage", { year: a.year, value: formatCurrency(a.avg, unit) })}</title>
            </line>
          ))}
        </svg>
        {geometry && last ? (
          <span className={`${styles.endLabel} ${styles.mono}`} style={{ left: "100%", top: `${(geometry.endY / H) * 100}%` }}>
            {formatCurrency(last.total, unit)}
          </span>
        ) : null}
      </div>
      <svg className={styles.strip} viewBox={`0 0 ${W} 10`} preserveAspectRatio="none" role="img" aria-label={t("expenses.spent.stripAria")}>
        {geometry
          ? (data?.day_strip ?? []).map((d, i) => {
              if (d.level === 0) return null;
              const w = W / geometry.n;
              const pickable = selectableMonths.has(d.day.slice(0, 7));
              return (
                <rect
                  key={d.day}
                  className={pickable ? styles.stripCell : undefined}
                  x={geometry.x(i) - w / 2}
                  y={0}
                  width={Math.max(w, 0.8)}
                  height={10}
                  fill="var(--accent)"
                  fillOpacity={LEVEL_OPACITY[d.level]}
                  onClick={pickable ? () => onDay(d.day) : undefined}
                >
                  <title>{`${d.day} · ${formatCurrency(d.total, unit)}`}</title>
                </rect>
              );
            })
          : null}
      </svg>
      <div className={styles.axis}>
        {geometry?.months.map((m, i) => {
          const monthIndex = Number(m.ym.slice(5, 7)) - 1;
          if (labelStride > 1 && monthIndex % labelStride !== 0 && i !== geometry.months.length - 1) return null;
          // A partial first month (the range starts mid-month) leaves its label to the next one.
          if (i === 0 && geometry.months.length > 1 && m.to - m.from < 14) return null;
          const pickable = selectableMonths.has(m.ym);
          const on = m.ym === selectedMonth;
          const label = labelStride >= 12 ? m.ym.slice(0, 4) : formatMonthShortLabel(m.ym);
          const style = { left: pct(geometry.x(m.from)) };
          return pickable ? (
            <button
              key={m.ym}
              type="button"
              className={`${styles.axisMonth} ${on ? styles.axisMonthOn : ""}`}
              style={style}
              onClick={() => onMonth(m.ym)}
            >
              {label}
            </button>
          ) : (
            <span key={m.ym} className={styles.axisMonth} style={style}>
              {label}
            </span>
          );
        })}
      </div>
      </div>
    </div>
  );
}
