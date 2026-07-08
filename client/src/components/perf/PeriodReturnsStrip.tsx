import { cn } from "../../cn";
import { formatClp, formatPct, formatUsdFine } from "../../format";
import { useTranslation } from "../../i18n";
import type { PeriodReturnCell, PeriodReturnKey, PeriodReturnsPayload } from "../../types";
import styles from "./PeriodReturnsStrip.module.css";

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

function toneClass(pct: number | null): string | undefined {
  if (pct == null || !Number.isFinite(pct) || pct === 0) return undefined;
  return pct > 0 ? styles.up : styles.down;
}

/**
 * Rentabilidad strip — chained flow-adjusted returns per period. Static (no NumberFlow):
 * the strip refetches wholesale on unit toggle. One responsive grid renders identically on
 * desktop and mobile. Formats at render time (decimal-separator convention).
 */
export function PeriodReturnsStrip({
  data,
  displayUnit,
}: {
  data: PeriodReturnsPayload;
  displayUnit: "clp" | "usd";
}) {
  const { t } = useTranslation();
  const formatNominal = displayUnit === "usd" ? formatUsdFine : formatClp;

  const renderCell = (cell: PeriodReturnCell) => {
    const label = t(PERIOD_LABEL_KEY[cell.period]);
    const isLive =
      (cell.period === "mtd" && data.mtd_is_live) || (cell.period === "d1" && data.d1_is_live);
    const cellTitle =
      cell.pct == null
        ? t("periodReturns.insufficientHistory")
        : cell.window_start_date
          ? t("periodReturns.windowTitleDate", { start: cell.window_start_date })
          : cell.window_start_month
            ? t("periodReturns.windowTitle", {
                start: cell.window_start_month,
                months: cell.months,
              })
            : t("periodReturns.insufficientHistory");

    return (
      <div key={cell.period} className={styles.cell} title={cellTitle}>
        <div className={styles.label}>
          {label}
          {isLive ? <span className={styles.live}> · {t("periodReturns.liveSuffix")}</span> : null}
        </div>
        <div className={cn(styles.pct, toneClass(cell.pct))}>
          {cell.pct == null ? "—" : formatPct(cell.pct * 100)}
        </div>
        {cell.nominal_pl != null ? (
          <div className={styles.nominal}>{formatNominal(cell.nominal_pl)}</div>
        ) : null}
        {cell.annualized_pct != null ? (
          <div className={styles.annualized}>
            {formatPct(cell.annualized_pct * 100)} {t("periodReturns.annualized")}
          </div>
        ) : null}
      </div>
    );
  };

  return <div className={styles.strip}>{data.periods.map(renderCell)}</div>;
}
