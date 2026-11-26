import { Fragment, type CSSProperties, type KeyboardEvent } from "react";
import { useTranslation } from "../../i18n";
import { cn } from "../../cn";
import { formatCompactMoney, formatCurrency } from "../../format";
import { loadableClass } from "../ui/Loadable";
import type { DisplayUnit } from "../../queries/keys";
import type {
  WealthBenchmarkCountry,
  WealthDistributionNote,
  WealthPercentileCell,
  WealthPercentileYearRow,
} from "../../types";
import {
  BENCHMARK_STROKE,
  CL_FINANCIAL_STROKE,
  CL_TOTAL_STROKE,
  percentileLabel,
  percentileLabelBelowThreshold,
} from "./wealthSeries";
import styles from "./WealthPercentile.module.css";

const NOTE_TAG_KEYS: Record<WealthDistributionNote, string> = {
  latest_distribution: "wealthPercentile.notes.latestDistribution.tag",
  interpolated: "wealthPercentile.notes.interpolated.tag",
  reconstructed: "wealthPercentile.notes.reconstructed.tag",
};

const NOTE_TEXT_KEYS: Record<WealthDistributionNote, string> = {
  latest_distribution: "wealthPercentile.notes.latestDistribution.text",
  interpolated: "wealthPercentile.notes.interpolated.text",
  reconstructed: "wealthPercentile.notes.reconstructed.text",
};

/** The order the notes are explained in under the list. */
const NOTE_ORDER: readonly WealthDistributionNote[] = ["latest_distribution", "interpolated", "reconstructed"];

const THRESHOLDS = ["p50", "p90", "p99"] as const;

/** Where the three threshold ticks sit on an opened year's scale (% of its width). */
const TICK_AT = { p50: 33, p90: 66, p99: 96 } as const;

/** A percentile on the threshold scale: straight lines between the ticks. */
function scalePosition(percentile: number): number {
  if (percentile <= 50) return (percentile / 50) * TICK_AT.p50;
  if (percentile <= 90) return TICK_AT.p50 + ((percentile - 50) / 40) * (TICK_AT.p90 - TICK_AT.p50);
  if (percentile <= 99) return TICK_AT.p90 + ((percentile - 90) / 9) * (TICK_AT.p99 - TICK_AT.p90);
  return TICK_AT.p99 + (percentile - 99) * (100 - TICK_AT.p99);
}

function onKeyActivate(e: KeyboardEvent, run: () => void) {
  if (e.key === "Enter" || e.key === " ") {
    e.preventDefault();
    run();
  }
}

type Distribution = {
  key: string;
  name: string;
  color: string;
  cell: WealthPercentileCell;
  /** The net worth placed in it: the financial one in Chile's financial-wealth distribution. */
  own: number;
};

/** What p50 / p90 / p99 took in each distribution of one year, and where the year's net worth stood. */
function YearThresholds({
  row,
  distributions,
  unit,
  id,
}: {
  row: WealthPercentileYearRow;
  distributions: readonly Distribution[];
  unit: DisplayUnit;
  id: string;
}) {
  const { t } = useTranslation();
  return (
    <div className={styles.opened} id={id}>
      <h3 className={styles.openedTitle}>{t("wealthPercentile.years.thresholds.title", { year: row.year })}</h3>
      <div className={styles.thresholds} role="table">
        <div className={cn(styles.thresholdRow, styles.thresholdHead)} role="row">
          <span role="columnheader">{t("wealthPercentile.years.thresholds.distribution")}</span>
          {THRESHOLDS.map((k) => (
            <span key={k} role="columnheader">
              {k}
            </span>
          ))}
          <span aria-hidden />
          <span role="columnheader">{t("wealthPercentile.years.thresholds.you")}</span>
        </div>
        {distributions.map((d) => {
          const percentile = d.cell.percentile;
          return (
            <div key={d.key} className={styles.thresholdRow} role="row">
              <span className={styles.thresholdName} role="rowheader">
                <span className={styles.swatch} style={{ background: d.color }} aria-hidden />
                {d.name}
              </span>
              {/* One cell per threshold: the amount in full while wide; narrow, its label and the
                  amount shortened (the header row is not drawn there). */}
              {THRESHOLDS.map((k) => (
                <span key={k} className={cn(styles.num, styles.threshold)} role="cell">
                  <span className={styles.thresholdLabel}>{k}</span>
                  <span className={styles.thresholdFull}>{formatCurrency(d.cell[k], unit)}</span>
                  <span className={styles.thresholdShort}>{formatCompactMoney(d.cell[k], unit)}</span>
                </span>
              ))}
              <span className={styles.scale} aria-hidden>
                {THRESHOLDS.map((k) => (
                  <span key={k} className={styles.scaleTick} style={{ left: `${TICK_AT[k]}%` }} />
                ))}
                {percentile != null ? (
                  <span
                    className={styles.scaleYou}
                    style={{ "--at": `${scalePosition(percentile)}%` } as CSSProperties}
                  />
                ) : null}
              </span>
              <span className={cn(styles.num, styles.you)} role="cell">
                {percentile == null ? t("wealthPercentile.belowSupport") : percentileLabelBelowThreshold(percentile)}
                <span className={styles.youAmount}> · {formatCurrency(d.own, unit)}</span>
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/**
 * The page's year list (the dashboard's full Returns list as its base): a row per year, newest
 * first, in the order the server sends. Wide, each row is a subgrid of the list — year, the words
 * for its distribution, net worth, the percentile in Chile, its two bars (total over financial),
 * the financial net worth and its percentile, one column per benchmark country; narrow (a
 * container query on the frame, whose breakpoint grows with the countries shown) a row is the
 * year, net worth and percentile, then the bars, then a muted line with the financial figures and
 * the benchmarks. A year opens in place into what p50 / p90 / p99 took in each distribution.
 */
export function WealthYearList({
  rows,
  countries,
  unit,
  latestDistributionYear,
  openYears,
  onToggleYear,
  loading,
}: {
  rows: readonly WealthPercentileYearRow[];
  /** The benchmark countries shown, in the server's order. */
  countries: readonly WealthBenchmarkCountry[];
  /** The unit the rows' amounts are in (the payload's). */
  unit: DisplayUnit;
  /** The newest databook year, named by the «latest distribution» note. */
  latestDistributionYear: number | null;
  openYears: ReadonlySet<number>;
  onToggleYear: (year: number) => void;
  loading?: boolean;
}) {
  const { t } = useTranslation();
  const money = (n: number) => formatCurrency(n, unit);
  const pct = (cell: WealthPercentileCell) =>
    cell.percentile == null ? t("wealthPercentile.belowSupport") : percentileLabel(cell.percentile);
  const noteTag = (note: WealthDistributionNote, row: WealthPercentileYearRow) =>
    t(NOTE_TAG_KEYS[note], { year: row.distribution_year });
  const notesShown = NOTE_ORDER.filter((n) => rows.some((r) => r.notes.includes(n)));

  const frameVars = {
    // The width below which a row no longer fits on one line. Measured 2026-11-26 on the synthetic
    // person in pesos: 39rem of fixed columns (nine-digit amounts, two notes) plus 3,4rem per
    // country; the margin is for longer amounts and the Spanish notes.
    fontSize: `${43 + 3.5 * countries.length}rem`,
    "--wealth-wide-columns": [
      // The notes give way first: their words wrap before a row outgrows the frame.
      "max-content minmax(0, max-content) max-content max-content minmax(3rem, 1fr) max-content max-content",
      ...countries.map(() => "max-content"),
      "max-content",
    ].join(" "),
  } as CSSProperties;

  return (
    <div className={loadableClass(loading, styles.frame)} style={frameVars} aria-busy={loading || undefined}>
      <div className={styles.years}>
        <div className={cn(styles.yearRow, styles.yearHead)} aria-hidden>
          <span className={styles.headLeft}>{t("wealthPercentile.years.year")}</span>
          <span />
          <span>{t("wealthPercentile.years.netWorth")}</span>
          <span>{t("wealthPercentile.series.chile")}</span>
          <span />
          <span>{t("wealthPercentile.years.financial")}</span>
          <span>{t("wealthPercentile.years.chileFinancial")}</span>
          {countries.map((c) => (
            <span key={c} title={t(`wealthPercentile.countries.${c}`)}>
              {c}
            </span>
          ))}
          <span />
        </div>
        {rows.map((row) => {
          const open = openYears.has(row.year);
          const bodyId = `wealth-year-${row.year}`;
          const distributions: Distribution[] = [
            {
              key: "cl_total",
              name: t("wealthPercentile.series.chile"),
              color: CL_TOTAL_STROKE,
              cell: row.cl_total,
              own: row.net_worth,
            },
            {
              key: "cl_financial",
              name: t("wealthPercentile.series.chileFinancialWealth"),
              color: CL_FINANCIAL_STROKE,
              cell: row.cl_financial,
              own: row.fin_net_worth,
            },
            ...countries.map((c) => ({
              key: c,
              name: t(`wealthPercentile.countries.${c}`),
              color: BENCHMARK_STROKE[c],
              cell: row.benchmarks[c],
              own: row.net_worth,
            })),
          ];
          return (
            <Fragment key={row.year}>
              <div
                className={cn(styles.yearRow, styles.opens, open && styles.open)}
                role="button"
                tabIndex={0}
                aria-expanded={open}
                aria-controls={open ? bodyId : undefined}
                aria-label={[
                  t("wealthPercentile.years.rowLabel", {
                    year: row.year,
                    percentile: pct(row.cl_total),
                    netWorth: money(row.net_worth),
                    financialPercentile: pct(row.cl_financial),
                    financialNetWorth: money(row.fin_net_worth),
                  }),
                  ...row.notes.map((n) => noteTag(n, row)),
                ].join(", ")}
                onClick={() => onToggleYear(row.year)}
                onKeyDown={(e) => onKeyActivate(e, () => onToggleYear(row.year))}
              >
                <span className={styles.year}>{row.year}</span>
                <span className={styles.notes}>
                  {row.notes.map((n) => (
                    <span key={n} className={cn(n === "reconstructed" && styles.noteEstimate)}>
                      {noteTag(n, row)}
                    </span>
                  ))}
                </span>
                <span className={cn(styles.num, styles.netWorth)}>{money(row.net_worth)}</span>
                <span className={cn(styles.num, styles.percentile)}>{pct(row.cl_total)}</span>
                <span className={styles.bars} aria-hidden>
                  <span className={styles.track}>
                    <span
                      className={styles.fill}
                      style={{ width: `${row.cl_total.percentile ?? 0}%`, background: "var(--text)" }}
                    />
                  </span>
                  <span className={styles.track}>
                    <span
                      className={styles.fill}
                      style={{ width: `${row.cl_financial.percentile ?? 0}%`, background: "var(--muted)" }}
                    />
                  </span>
                </span>
                <span className={cn(styles.num, styles.muted, styles.wideOnly)}>{money(row.fin_net_worth)}</span>
                <span className={cn(styles.num, styles.wideOnly)}>{pct(row.cl_financial)}</span>
                {countries.map((c) => (
                  <span key={c} className={cn(styles.num, styles.muted, styles.wideOnly)}>
                    {pct(row.benchmarks[c])}
                  </span>
                ))}
                <span className={styles.chevron} aria-hidden>
                  ›
                </span>
                {/* Narrow: the financial figures and the benchmarks on a line of their own. */}
                <span className={styles.detail}>
                  <span>
                    <span className={styles.swatch} style={{ background: "var(--muted)" }} aria-hidden />
                    {t("wealthPercentile.years.financialDetail", {
                      percentile: pct(row.cl_financial),
                      amount: money(row.fin_net_worth),
                    })}
                  </span>
                  {countries.length > 0 ? (
                    <span className={styles.detailCountries}>
                      {countries.map((c) => (
                        <span key={c}>
                          {c} {pct(row.benchmarks[c])}
                        </span>
                      ))}
                    </span>
                  ) : null}
                </span>
              </div>
              {open ? <YearThresholds row={row} distributions={distributions} unit={unit} id={bodyId} /> : null}
            </Fragment>
          );
        })}
      </div>
      {notesShown.length > 0 ? (
        <dl className={styles.noteKey}>
          {notesShown.map((n) => (
            <div key={n}>
              <dt className={cn(n === "reconstructed" && styles.noteEstimate)}>
                {t(NOTE_TAG_KEYS[n], { year: latestDistributionYear })}
              </dt>
              <dd>{t(NOTE_TEXT_KEYS[n])}</dd>
            </div>
          ))}
        </dl>
      ) : null}
    </div>
  );
}
