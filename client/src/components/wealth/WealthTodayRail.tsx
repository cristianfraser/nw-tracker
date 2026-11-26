import { useTranslation } from "../../i18n";
import { cn } from "../../cn";
import type { WealthBenchmarkCountry, WealthPercentileCell, WealthPercentileYearRow } from "../../types";
import {
  BENCHMARK_COUNTRIES,
  BENCHMARK_STROKE,
  CL_FINANCIAL_STROKE,
  CL_TOTAL_STROKE,
  percentileLabel,
} from "./wealthSeries";
import styles from "./WealthPercentile.module.css";

function StandingRow({
  name,
  color,
  cell,
  own,
}: {
  name: string;
  color: string;
  cell: WealthPercentileCell | null;
  /** Chile's two rows read brighter than the benchmarks'. */
  own?: boolean;
}) {
  const { t } = useTranslation();
  const percentile = cell?.percentile ?? null;
  return (
    <li className={cn(styles.standing, own && styles.standingOwn)}>
      <span className={styles.standingName}>
        <span className={styles.swatch} style={{ background: color }} aria-hidden />
        {name}
      </span>
      <span className={styles.track} aria-hidden>
        {percentile != null ? (
          <span className={styles.fill} style={{ width: `${percentile}%`, background: color }} />
        ) : null}
      </span>
      <span className={styles.standingValue}>
        {cell == null ? "" : percentile == null ? t("wealthPercentile.belowSupport") : percentileLabel(percentile)}
      </span>
    </li>
  );
}

/**
 * The rail beside the chart: today's percentile in each distribution drawn, one label | bar |
 * figure row per chart line in the line's colour (it is the chart's legend), then the benchmark
 * countries as on / off buttons.
 */
export function WealthTodayRail({
  latest,
  countries,
  enabled,
  onToggle,
}: {
  /** The newest year's row; null while loading (the rows keep their names, without figures). */
  latest: WealthPercentileYearRow | null;
  /** The benchmark countries drawn, in the server's order. */
  countries: readonly WealthBenchmarkCountry[];
  enabled: readonly WealthBenchmarkCountry[];
  onToggle: (country: WealthBenchmarkCountry) => void;
}) {
  const { t } = useTranslation();
  return (
    <div className={styles.rail}>
      <h2>{t("wealthPercentile.rail.title")}</h2>
      <ul className={styles.standings}>
        <StandingRow
          name={t("wealthPercentile.series.chile")}
          color={CL_TOTAL_STROKE}
          cell={latest?.cl_total ?? null}
          own
        />
        <StandingRow
          name={t("wealthPercentile.series.chileFinancial")}
          color={CL_FINANCIAL_STROKE}
          cell={latest?.cl_financial ?? null}
          own
        />
      </ul>
      {countries.length > 0 ? (
        <ul className={cn(styles.standings, styles.railGroup)}>
          {countries.map((c) => (
            <StandingRow
              key={c}
              name={t(`wealthPercentile.countries.${c}`)}
              color={BENCHMARK_STROKE[c]}
              cell={latest?.benchmarks[c] ?? null}
            />
          ))}
        </ul>
      ) : null}
      <div className={cn(styles.railGroup, styles.picker)}>
        <span className={styles.pickerLabel} id="wealth-compare-label">
          {t("wealthPercentile.rail.compareWith")}
        </span>
        <span className="surface-controls__set" role="group" aria-labelledby="wealth-compare-label">
          {BENCHMARK_COUNTRIES.map((c) => {
            const on = enabled.includes(c);
            return (
              <button
                key={c}
                type="button"
                className={on ? "is-on" : undefined}
                aria-pressed={on}
                title={t(`wealthPercentile.countries.${c}`)}
                aria-label={t(`wealthPercentile.countries.${c}`)}
                onClick={() => onToggle(c)}
              >
                {c}
              </button>
            );
          })}
        </span>
      </div>
    </div>
  );
}
