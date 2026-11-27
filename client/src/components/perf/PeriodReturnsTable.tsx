import type { CSSProperties, ReactNode } from "react";
import { BenchmarkSelectOptions, benchmarkOptionLabel } from "../../benchmarkLabels";
import { cn } from "../../cn";
import { formatMoney, formatPct } from "../../format";
import { useTranslation } from "../../i18n";
import { useDisplayPreferences } from "../../context/DisplayPreferencesContext";
import { useBenchmarks, useHeldBenchmarkComparison } from "../../queries/hooks";
import { useSurfaceBenchmark } from "../../surfaceDisplayPrefs";
import type {
  BenchmarkComparisonCell,
  BenchmarkComparisonPayload,
  BenchmarkOption,
  PeriodReturnCell,
  PeriodReturnKey,
  PeriodReturnsPayload,
} from "../../types";
import { loadableClass } from "../ui/Loadable";
import styles from "./PeriodReturnsTable.module.css";
import type { DisplayUnit } from "../../queries/keys";

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

/** Every Rentabilidad list compares against the mortgage until the user picks another. */
const DEFAULT_BENCHMARK = "mortgage";

/** Periods the lists show while the payload loads (blank rows, the loaded lists' usual height). */
const COMPACT_PENDING_PERIODS: readonly PeriodReturnKey[] = ["d1", "w1", "mtd", "ytd", "total"];
const FULL_PENDING_PERIODS: readonly PeriodReturnKey[] = ["d1", "w1", "mtd", "ytd", "y1", "total"];

const BLANK = " ";
/** A figure the server sent as null once its payload is in (blank is only for «still loading»). */
const DASH = "—";

/** A figure's name for a screen reader (the column labels are visual only). */
function SrLabel({ children }: { children: string }) {
  return <span className="visually-hidden">{children} </span>;
}

function toneClass(n: number | null | undefined): string | undefined {
  if (n == null || !Number.isFinite(n) || n === 0) return undefined;
  return n > 0 ? styles.up : styles.down;
}

type BenchmarkComparisonProps = {
  options: readonly BenchmarkOption[];
  selected: string;
  onSelect: (slug: string) => void;
  /** Null while loading. In the list's unit, or (held, just after the list flipped) the last one. */
  data: BenchmarkComparisonPayload | null;
  /** `data` is held from before (a unit switch): its figures dim. */
  loading: boolean;
};

type ListRow = {
  period: PeriodReturnKey;
  cell: PeriodReturnCell | null;
  bench: BenchmarkComparisonCell | undefined;
};

/**
 * One line per period carrying a figure of its own — a % or a P/L (a period with neither, e.g. 5Y
 * on a two-year history, is left out; a null % then prints «—»); while the payload loads, the
 * `pending` periods with blank figures. The set does not depend on the comparison, so it does not
 * change when that lands.
 */
function listRows(
  data: PeriodReturnsPayload | null,
  comparison: BenchmarkComparisonProps,
  pending: readonly PeriodReturnKey[]
): ListRow[] {
  const benchByPeriod = new Map<PeriodReturnKey, BenchmarkComparisonCell>();
  for (const c of comparison.data?.periods ?? []) benchByPeriod.set(c.period, c);
  if (data == null) return pending.map((period) => ({ period, cell: null, bench: undefined }));
  return data.periods
    .filter((c) => c.pct != null || c.nominal_pl != null)
    .map((cell) => ({ period: cell.period, cell, bench: benchByPeriod.get(cell.period) }));
}

/** The heading row both lists share: the title and the «vs <benchmark> ▾» picker. */
function ReturnsHeading({
  title,
  titleAs: Title,
  comparison,
}: {
  title: ReactNode;
  titleAs: "h2" | "h3";
  comparison: BenchmarkComparisonProps;
}) {
  const { t } = useTranslation();
  return (
    <div className="chart-panel-title-row">
      <Title>{title}</Title>
      <label className={styles.picker}>
        <span>{t("periodReturns.versus")}</span>
        <select
          className={styles.pickerSelect}
          aria-label={t("periodReturns.compareWith")}
          value={comparison.selected}
          onChange={(e) => comparison.onSelect(e.target.value)}
        >
          <BenchmarkSelectOptions t={t} options={comparison.options} />
        </select>
      </label>
    </div>
  );
}

/**
 * Where the gap bars' zero sits, shared by every row of the list so all bars start from one
 * origin: at the left edge when no figure is negative, else as far right as the most negative row
 * needs (its negative share of the row's range), never past mid-track.
 */
function gapBarsZero(pairs: readonly (readonly (number | null)[])[]): number {
  let share = 0;
  for (const pair of pairs) {
    const neg = Math.max(0, ...pair.map((v) => -(v ?? 0)));
    const pos = Math.max(0, ...pair.map((v) => v ?? 0));
    if (neg > 0) share = Math.max(share, neg / (neg + pos));
  }
  return Math.min(0.5, share);
}

/**
 * The gap bars: your % over the benchmark's from the list's shared zero (`gapBarsZero`), on the
 * row's own scale (the larger magnitude fills its side of the track). Geometry only — both figures
 * are the server's.
 */
function GapBars({
  you,
  bench,
  zero: z,
  title,
}: {
  you: number | null;
  bench: number | null;
  zero: number;
  title: string;
}) {
  const neg = Math.max(0, -(you ?? 0), -(bench ?? 0));
  const pos = Math.max(0, you ?? 0, bench ?? 0);
  const scale = Math.min(neg > 0 ? z / neg : Infinity, pos > 0 ? (1 - z) / pos : Infinity);
  const split = z > 0;
  const zero = z * 100;
  const bar = (v: number | null, className: string) => {
    let fill: CSSProperties | null = null;
    if (v != null && v !== 0 && Number.isFinite(scale)) {
      const w = Math.abs(v) * scale * 100;
      fill = { left: `${v < 0 ? zero - w : zero}%`, width: `${w}%` };
    }
    return (
      <span className={styles.track}>
        {split ? <span className={styles.zero} style={{ left: `${zero}%` }} /> : null}
        {fill ? <span className={cn(styles.fill, className)} style={fill} /> : null}
      </span>
    );
  };
  return (
    <span className={styles.bars} title={title} aria-hidden>
      {bar(you, you != null && you < 0 ? styles.fillDown : styles.fillUp)}
      {bar(bench, styles.fillBench)}
    </span>
  );
}

/**
 * Rentabilidad — one line per period with a return, in the payload's order: the chained
 * flow-adjusted % (its yearly rate under it on windows over a year), the P/L, the money's IRR, a
 * pair of bars (your % over the benchmark's), the benchmark's %, the P/L the same flows would have
 * made there (shadow) and its IRR, and Δ = your P/L − the shadow's. Every figure is server-computed.
 * Column labels head the list while one line per period fits its frame; narrower (a container
 * query on the frame, never the viewport) each period is three lines: %, P/L and Δ; the bars; the
 * IRRs and the benchmark's figures, muted, the benchmark marked by its bar's swatch.
 */
function PeriodReturnsFullList({
  title,
  titleAs,
  data,
  displayUnit,
  comparison,
  loading,
}: {
  title: ReactNode;
  titleAs: "h2" | "h3";
  data: PeriodReturnsPayload | null;
  displayUnit: DisplayUnit;
  comparison: BenchmarkComparisonProps;
  loading?: boolean;
}) {
  const { t } = useTranslation();
  const rows = listRows(data, comparison, FULL_PENDING_PERIODS);
  const barsZero = gapBarsZero(rows.map(({ cell, bench: b }) => [cell?.pct ?? null, b?.benchmark_pct ?? null]));
  const selected = comparison.options.find((o) => o.slug === comparison.selected);
  const benchLabel = selected ? benchmarkOptionLabel(t, selected) : "";
  const benchPending = comparison.data == null;
  const benchDim = cn((benchPending || comparison.loading) && !loading && styles.pending);
  // Each figure in its own payload's unit (a held comparison may briefly be in another than the list).
  const money = (n: number | null | undefined) => (n != null ? formatMoney({ value: n, currency: displayUnit }) : null);
  const benchUnit = comparison.data?.unit;
  const benchMoney = (n: number | null | undefined) =>
    n != null && benchUnit != null ? formatMoney({ value: n, currency: benchUnit }) : null;
  const pctText = (n: number | null | undefined) => (n != null ? formatPct(n * 100) : null);
  // Own figures are blank only on a pending row (no cell); the benchmark's while the comparison loads.
  const own = (cell: PeriodReturnCell | null, s: string | null) => (cell == null ? BLANK : (s ?? DASH));
  const benchFig = (s: string | null) => (benchPending ? BLANK : (s ?? DASH));
  const srBench = (figure: string) => t("periodReturns.srBench", { benchmark: benchLabel, figure });
  const perYear = (n: number) => t("periodReturns.annualizedValue", { pct: formatPct(n * 100) });
  const yearly = (n: number | null | undefined) =>
    n != null ? (
      <span className={styles.yearly} title={t("periodReturns.annualizedTitle")}>
        {perYear(n)}
      </span>
    ) : null;
  // The IRR columns (their label names them): the rate, «p.a.» when it is yearly.
  const irrCell = (n: number | null | undefined, annual: boolean | undefined) =>
    n == null ? null : annual ? perYear(n) : formatPct(n * 100);
  // The narrow detail line names the IRR itself.
  const irrText = (n: number | null | undefined, annual: boolean | undefined) =>
    n == null ? null : t(annual ? "periodReturns.irrAnnual" : "periodReturns.irr", { pct: formatPct(n * 100) });

  const cellTitle = (cell: PeriodReturnCell | null): string | undefined => {
    if (cell == null || loading) return undefined;
    if (cell.window_start_date) return t("periodReturns.windowTitleDate", { start: cell.window_start_date });
    if (cell.window_start_month) {
      return t("periodReturns.windowTitle", { start: cell.window_start_month, months: cell.months });
    }
    return undefined;
  };
  const benchTitle = (b: BenchmarkComparisonCell | undefined): string | undefined => {
    if (benchPending) return undefined;
    return b?.benchmark_pct == null
      ? t("periodReturns.benchmarkUnavailable", { benchmark: benchLabel })
      : t("periodReturns.shadowTitle", { benchmark: benchLabel, start: b.window_start_date ?? "—" });
  };

  return (
    <>
      <ReturnsHeading title={title} titleAs={titleAs} comparison={comparison} />
      {rows.length === 0 ? <p className={styles.empty}>{t("periodReturns.empty")}</p> : null}
      <div className={styles.frame} hidden={rows.length === 0}>
        <div role="list" className={loadableClass(loading, styles.full)} aria-busy={loading || undefined}>
          <div className={cn(styles.fullRow, styles.colHead)} aria-hidden>
            <span />
            <span>{t("periodReturns.colPct")}</span>
            <span>{t("periodReturns.colPl")}</span>
            <span>{t("periodReturns.colIrr")}</span>
            <span />
            <span>
              <span className={styles.swatch} title={benchLabel} />
              {t("periodReturns.colPct")}
            </span>
            <span>{t("periodReturns.colPl")}</span>
            <span>{t("periodReturns.colIrr")}</span>
            <span>{t("periodReturns.colDelta")}</span>
          </div>
          {rows.map(({ period, cell, bench: b }) => {
            // The narrow line's benchmark figures, each named for a screen reader and kept whole
            // (the line wraps only between them).
            const shadowDetail = [
              [t("periodReturns.srReturn"), pctText(b?.benchmark_pct)],
              [t("periodReturns.annualizedTitle"), b?.benchmark_annualized_pct != null ? perYear(b.benchmark_annualized_pct) : null],
              [t("periodReturns.srPl"), benchMoney(b?.shadow_pl)],
              [t("periodReturns.srIrr"), irrText(b?.shadow_irr_pct, b?.irr_annualized)],
            ]
              .filter((piece): piece is [string, string] => piece[1] != null)
              .map(([label, text]) => [label, text.replace(/ /g, "\u00a0")] as const);
            return (
              <div key={period} role="listitem" className={cn(styles.fullRow, period === "total" && styles.total)}>
                <span className={styles.label}>{t(PERIOD_LABEL_KEY[period])}</span>
                <span className={cn("mono", styles.num)} title={cellTitle(cell)}>
                  <SrLabel>{t("periodReturns.srReturn")}</SrLabel>
                  <span className={toneClass(cell?.pct)}>{own(cell, pctText(cell?.pct))}</span>
                  {yearly(cell?.annualized_pct)}
                </span>
                <span className={cn("mono", styles.num, toneClass(cell?.nominal_pl))}>
                  <SrLabel>{t("periodReturns.srPl")}</SrLabel>
                  {own(cell, money(cell?.nominal_pl))}
                </span>
                <span
                  className={cn("mono", styles.num, styles.muted, styles.wideOnly, benchDim)}
                  title={t("periodReturns.irrTitle")}
                >
                  <SrLabel>{t("periodReturns.srIrr")}</SrLabel>
                  {benchFig(irrCell(b?.real_irr_pct, b?.irr_annualized))}
                </span>
                <GapBars
                  you={cell?.pct ?? null}
                  bench={b?.benchmark_pct ?? null}
                  zero={barsZero}
                  title={t("periodReturns.barsTitle", { benchmark: benchLabel })}
                />
                <span className={cn("mono", styles.num, styles.muted, styles.wideOnly, benchDim)} title={benchTitle(b)}>
                  <SrLabel>{srBench(t("periodReturns.srReturn"))}</SrLabel>
                  <span>{benchFig(pctText(b?.benchmark_pct))}</span>
                  {yearly(b?.benchmark_annualized_pct)}
                </span>
                <span className={cn("mono", styles.num, styles.muted, styles.wideOnly, benchDim)} title={benchTitle(b)}>
                  <SrLabel>{srBench(t("periodReturns.srPl"))}</SrLabel>
                  {benchFig(benchMoney(b?.shadow_pl))}
                </span>
                <span
                  className={cn("mono", styles.num, styles.muted, styles.wideOnly, benchDim)}
                  title={t("periodReturns.irrTitle")}
                >
                  <SrLabel>{srBench(t("periodReturns.srIrr"))}</SrLabel>
                  {benchFig(irrCell(b?.shadow_irr_pct, b?.irr_annualized))}
                </span>
                <span className={cn("mono", styles.num, styles.delta, toneClass(b?.delta_pl), benchDim)}>
                  <SrLabel>{t("periodReturns.srDelta", { benchmark: benchLabel })}</SrLabel>
                  {benchFig(b?.delta_pl != null ? t("periodReturns.delta", { amount: benchMoney(b.delta_pl) }) : null)}
                </span>
                <span className={cn("mono", styles.detail, benchDim)}>
                  <span title={t("periodReturns.irrTitle")}>
                    {benchFig(irrText(b?.real_irr_pct, b?.irr_annualized))}
                  </span>
                  <span className={styles.detailBench} title={benchTitle(b)}>
                    <span className={styles.swatch} />
                    {shadowDetail.length
                      ? shadowDetail.map(([label, text], i) => (
                          <span key={label}>
                            {i > 0 ? <span aria-hidden>{" · "}</span> : null}
                            <SrLabel>{srBench(label)}</SrLabel>
                            {text}
                          </span>
                        ))
                      : benchFig(null)}
                  </span>
                </span>
              </div>
            );
          })}
        </div>
      </div>
    </>
  );
}

/**
 * Rentabilidad as a short list (a page that places it beside a chart): one line per period the
 * payload has a return for — its label, the % (green / red), the amount, the benchmark's % muted at
 * the right — a hairline under each. Every figure is the payload's and the comparison's, as in the
 * full list.
 */
function PeriodReturnsCompactList({
  title,
  titleAs,
  data,
  displayUnit,
  comparison,
  loading,
}: {
  title: ReactNode;
  titleAs: "h2" | "h3";
  data: PeriodReturnsPayload | null;
  displayUnit: DisplayUnit;
  comparison: BenchmarkComparisonProps;
  loading?: boolean;
}) {
  const { t } = useTranslation();
  const rows = listRows(data, comparison, COMPACT_PENDING_PERIODS);
  const selected = comparison.options.find((o) => o.slug === comparison.selected);
  const benchLabel = selected ? benchmarkOptionLabel(t, selected) : "";
  const benchPending = comparison.data == null;
  const benchDim = cn(comparison.loading && !loading && styles.pending);
  return (
    <>
      <ReturnsHeading title={title} titleAs={titleAs} comparison={comparison} />
      {rows.length === 0 ? (
        <p className={styles.empty}>{t("periodReturns.empty")}</p>
      ) : (
        <div role="list" className={loadableClass(loading, styles.compactList)} aria-busy={loading || undefined}>
          {rows.map(({ period, cell, bench: b }) => (
            <div key={period} role="listitem" className={cn(styles.compactRow, period === "total" && styles.total)}>
              <span className={styles.label}>{t(PERIOD_LABEL_KEY[period])}</span>
              <span className={cn("mono", styles.num, toneClass(cell?.pct))}>
                <SrLabel>{t("periodReturns.srReturn")}</SrLabel>
                {cell == null ? BLANK : cell.pct != null ? formatPct(cell.pct * 100) : DASH}
              </span>
              <span className={cn("mono", styles.num, toneClass(cell?.nominal_pl))}>
                <SrLabel>{t("periodReturns.srPl")}</SrLabel>
                {cell == null
                  ? BLANK
                  : cell.nominal_pl != null
                    ? formatMoney({ value: cell.nominal_pl, currency: displayUnit })
                    : DASH}
              </span>
              <span className={cn("mono", styles.num, styles.compactBench, benchDim)}>
                <SrLabel>{t("periodReturns.srBench", { benchmark: benchLabel, figure: t("periodReturns.srReturn") })}</SrLabel>
                {benchPending ? BLANK : b?.benchmark_pct != null ? formatPct(b.benchmark_pct * 100) : DASH}
              </span>
            </div>
          ))}
        </div>
      )}
    </>
  );
}

/**
 * Rentabilidad with its benchmark comparison: the choice is remembered per surface
 * (`<pageKey>.returns`), default the mortgage. A stored slug the server no longer lists falls
 * back to the default. `data` is null only while the payload loads (callers pass null with
 * `loading`, never as a server-stated absence — that gate stays on the caller); the comparison is
 * not fetched until a list is on screen. It is requested in the unit of the list on screen (the
 * display unit's warmed meanwhile) and held across a change of it, each figure in its own
 * payload's unit; after the list flips, the held comparison stays (dimmed) until the new one is in.
 * Static (no NumberFlow): figures format at render time.
 */
export function PeriodReturnsWithBenchmark({
  title,
  titleAs = "h2",
  data,
  scope,
  surfaceId,
  loading,
  compact,
}: {
  /** The heading, in one row with the benchmark picker. */
  title: ReactNode;
  titleAs?: "h2" | "h3";
  /** The list on screen (this unit's, or held from before in its own unit). */
  data: PeriodReturnsPayload | null;
  scope: { accountId: number } | { portfolioGroup: string };
  /** Null until the page's scope is known (its benchmark choice is not read or stored). */
  surfaceId: string | null;
  /** The payload is not in yet (or is held prior data): the list dims. */
  loading?: boolean;
  /** The short list (%, amount and the benchmark's % per period) instead of the full one. */
  compact?: boolean;
}) {
  const { displayUnit } = useDisplayPreferences();
  const { benchmark, setBenchmark } = useSurfaceBenchmark(surfaceId, DEFAULT_BENCHMARK);
  const benchmarks = useBenchmarks();
  const options = benchmarks.data?.benchmarks ?? [];
  const selected = options.some((o) => o.slug === benchmark) ? benchmark : DEFAULT_BENCHMARK;
  // A list pending with nothing to show has no unit yet: no comparison is asked for beside it.
  const listUnit = data?.unit;
  // Asked for in the list's own unit, so the pair flips together; the display unit's is warmed
  // while the list still shows another one.
  const comparison = useHeldBenchmarkComparison(
    scope,
    selected,
    listUnit ?? displayUnit,
    displayUnit,
    data != null && options.some((o) => o.slug === selected)
  );
  const cmp = comparison.data;
  // The list's unit's comparison, or — just after the list flipped, while its new unit's is in
  // flight — the one held from before, dimmed in its own unit: the figures never go blank.
  const shown =
    cmp != null && cmp.benchmark.slug === selected && (cmp.unit === listUnit || comparison.held) ? cmp : null;
  const comparisonProps: BenchmarkComparisonProps = {
    options,
    selected,
    onSelect: setBenchmark,
    data: shown,
    loading: shown != null && comparison.loading,
  };
  const List = compact ? PeriodReturnsCompactList : PeriodReturnsFullList;
  return (
    <List
      title={title}
      titleAs={titleAs}
      data={data}
      displayUnit={listUnit ?? displayUnit}
      comparison={comparisonProps}
      loading={loading}
    />
  );
}
