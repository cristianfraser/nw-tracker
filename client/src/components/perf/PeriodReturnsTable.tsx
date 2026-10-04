import type { CSSProperties } from "react";
import { benchmarkOptionLabel } from "../../benchmarkLabels";
import { cn } from "../../cn";
import { formatClp, formatPct, formatUsdFine } from "../../format";
import { useTranslation } from "../../i18n";
import { useBenchmarkComparison, useBenchmarks } from "../../queries/hooks";
import { useSurfaceBenchmark } from "../../surfaceDisplayPrefs";
import type {
  BenchmarkComparisonCell,
  BenchmarkComparisonPayload,
  BenchmarkOption,
  PeriodReturnCell,
  PeriodReturnKey,
  PeriodReturnsPayload,
} from "../../types";
import { Table } from "../ui/Table";
import styles from "./PeriodReturnsTable.module.css";

const PERIOD_LABEL_KEY: Record<PeriodReturnKey, string> = {
  d1: "periodReturns.d1",
  w1: "periodReturns.w1",
  mtd: "periodReturns.mtd",
  ytd: "periodReturns.ytd",
  y1: "periodReturns.y1",
  y3: "periodReturns.y3",
  y5: "periodReturns.y5",
  total: "periodReturns.total",
};

/** Every Rentabilidad table compares against the mortgage until the user picks another. */
const DEFAULT_BENCHMARK = "mortgage";

function toneClass(n: number | null): string | undefined {
  if (n == null || !Number.isFinite(n) || n === 0) return undefined;
  return n > 0 ? styles.up : styles.down;
}

/** Grid placement for the flipped (mobile) layout; ignored by the desktop table. */
function cellPos(row: number, col: number): CSSProperties {
  return { "--r": row, "--c": col } as CSSProperties;
}

export type BenchmarkComparisonProps = {
  options: readonly BenchmarkOption[];
  selected: string;
  onSelect: (slug: string) => void;
  /** Null while loading, or while it is in another unit than the table. */
  data: BenchmarkComparisonPayload | null;
};

/**
 * Rentabilidad — chained flow-adjusted returns, one column per period (%, nominal amount,
 * annualized where it applies), in the payload's order. With `comparison`, a second row shows
 * a selectable benchmark: its return over the same window, what the same flows would have made
 * there (shadow P/L) and Δ = real P/L − that, and both rows gain the money's IRR (yearly
 * on windows of a year or more) — all server-computed. Static (no NumberFlow): it
 * refetches wholesale on unit toggle. Formats at render time (decimal-separator convention).
 * One markup for both viewports — narrow screens flip it to one row per period (CSS).
 */
export function PeriodReturnsTable({
  data,
  displayUnit,
  comparison,
}: {
  data: PeriodReturnsPayload;
  displayUnit: "clp" | "usd";
  comparison?: BenchmarkComparisonProps;
}) {
  const { t } = useTranslation();
  const formatNominal = displayUnit === "usd" ? formatUsdFine : formatClp;
  const compare = comparison != null;

  const cellTitle = (cell: PeriodReturnCell): string => {
    if (cell.pct == null) return t("periodReturns.insufficientHistory");
    if (cell.window_start_date) {
      return t("periodReturns.windowTitleDate", { start: cell.window_start_date });
    }
    if (cell.window_start_month) {
      return t("periodReturns.windowTitle", {
        start: cell.window_start_month,
        months: cell.months,
      });
    }
    return t("periodReturns.insufficientHistory");
  };

  const benchmarkLabel = (o: BenchmarkOption): string => benchmarkOptionLabel(t, o);
  const selectedOption = comparison?.options.find((o) => o.slug === comparison.selected);
  const selectedLabel = selectedOption ? benchmarkLabel(selectedOption) : "";

  const irr = (pct: number | null | undefined, annualized: boolean | undefined) =>
    pct != null ? (
      <div className={styles.irr} title={t("periodReturns.irrTitle")}>
        {t(annualized ? "periodReturns.irrAnnual" : "periodReturns.irr", {
          pct: formatPct(pct * 100),
        })}
      </div>
    ) : null;

  const benchByPeriod = new Map<PeriodReturnKey, BenchmarkComparisonCell>();
  for (const c of comparison?.data?.periods ?? []) benchByPeriod.set(c.period, c);

  const header = (
    <thead>
      <tr>
        {compare ? <th className={styles.corner} style={cellPos(1, 1)} /> : null}
        {data.periods.map((cell, i) => (
          <th key={cell.period} className={styles.head} style={cellPos(i + 2, 1)}>
            {t(PERIOD_LABEL_KEY[cell.period])}
          </th>
        ))}
      </tr>
    </thead>
  );

  return (
    <Table header={header} tableClassName={cn(styles.table, compare && styles.compare)}>
      <tr>
        {compare ? (
          <th scope="row" className={styles.rowHead} style={cellPos(1, 2)}>
            {t("periodReturns.actual")}
          </th>
        ) : null}
        {data.periods.map((cell, i) => (
          <td key={cell.period} title={cellTitle(cell)} style={cellPos(i + 2, 2)}>
            <div className={cn(styles.pct, toneClass(cell.pct))}>
              {cell.pct == null ? "—" : formatPct(cell.pct * 100)}
            </div>
            {cell.nominal_pl != null ? (
              <div className={styles.nominal}>{formatNominal(cell.nominal_pl)}</div>
            ) : null}
            {irr(
              benchByPeriod.get(cell.period)?.real_irr_pct,
              benchByPeriod.get(cell.period)?.irr_annualized
            )}
            {cell.annualized_pct != null ? (
              <div className={styles.annualized}>
                {formatPct(cell.annualized_pct * 100)} {t("periodReturns.annualized")}
              </div>
            ) : null}
          </td>
        ))}
      </tr>
      {comparison ? (
        <tr>
          <th scope="row" className={styles.rowHead} style={cellPos(1, 3)}>
            <select
              className={styles.benchmarkSelect}
              aria-label={t("periodReturns.compareWith")}
              value={comparison.selected}
              onChange={(e) => comparison.onSelect(e.target.value)}
            >
              {comparison.options.map((o) => (
                <option key={o.slug} value={o.slug}>
                  {benchmarkLabel(o)}
                </option>
              ))}
            </select>
          </th>
          {data.periods.map((cell, i) => {
            const b = benchByPeriod.get(cell.period);
            const title =
              b?.benchmark_pct == null
                ? t("periodReturns.benchmarkUnavailable", { benchmark: selectedLabel })
                : t("periodReturns.shadowTitle", {
                    benchmark: selectedLabel,
                    start: b.window_start_date ?? "—",
                  });
            return (
              <td
                key={cell.period}
                title={comparison.data ? title : undefined}
                className={cn(comparison.data == null && styles.pending)}
                style={cellPos(i + 2, 3)}
              >
                <div className={cn(styles.pct, toneClass(b?.benchmark_pct ?? null))}>
                  {b?.benchmark_pct == null ? "—" : formatPct(b.benchmark_pct * 100)}
                </div>
                {b?.shadow_pl != null ? (
                  <div className={styles.nominal}>{formatNominal(b.shadow_pl)}</div>
                ) : null}
                {irr(b?.shadow_irr_pct, b?.irr_annualized)}
                {b?.benchmark_annualized_pct != null ? (
                  <div className={styles.annualized}>
                    {formatPct(b.benchmark_annualized_pct * 100)} {t("periodReturns.annualized")}
                  </div>
                ) : null}
                {b?.delta_pl != null ? (
                  <div className={cn(styles.delta, toneClass(b.delta_pl))}>
                    {t("periodReturns.delta", { amount: formatNominal(b.delta_pl) })}
                  </div>
                ) : null}
              </td>
            );
          })}
        </tr>
      ) : null}
    </Table>
  );
}

/**
 * The Rentabilidad table with its benchmark row: the choice is remembered per surface
 * (`<pageKey>.returns`), default the mortgage. A stored slug the server no longer lists falls
 * back to the default.
 */
export function PeriodReturnsWithBenchmark({
  data,
  displayUnit,
  scope,
  surfaceId,
}: {
  data: PeriodReturnsPayload;
  displayUnit: "clp" | "usd";
  scope: { accountId: number } | { portfolioGroup: string };
  surfaceId: string;
}) {
  const { benchmark, setBenchmark } = useSurfaceBenchmark(surfaceId, DEFAULT_BENCHMARK);
  const benchmarks = useBenchmarks();
  const options = benchmarks.data?.benchmarks ?? [];
  const selected = options.some((o) => o.slug === benchmark) ? benchmark : DEFAULT_BENCHMARK;
  const comparison = useBenchmarkComparison(
    scope,
    selected,
    displayUnit,
    options.some((o) => o.slug === selected)
  );
  const cmp = comparison.data;
  return (
    <PeriodReturnsTable
      data={data}
      displayUnit={displayUnit}
      comparison={{
        options,
        selected,
        onSelect: setBenchmark,
        data:
          cmp != null && cmp.unit === displayUnit && cmp.benchmark.slug === selected ? cmp : null,
      }}
    />
  );
}
