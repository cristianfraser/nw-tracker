import { cn } from "../../cn";
import { formatClp, formatPct, formatUsdFine } from "../../format";
import { useTranslation } from "../../i18n";
import type { PeriodReturnCell, PeriodReturnKey, PeriodReturnsPayload } from "../../types";
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

function toneClass(pct: number | null): string | undefined {
  if (pct == null || !Number.isFinite(pct) || pct === 0) return undefined;
  return pct > 0 ? styles.up : styles.down;
}

/**
 * Rentabilidad — chained flow-adjusted returns, one column per period and a single row of
 * values (%, nominal amount, annualized where it applies), in the payload's order. Static
 * (no NumberFlow): it refetches wholesale on unit toggle. Each cell's `title` carries the
 * window the period covers. Formats at render time (decimal-separator convention).
 * One rendering for both viewports — narrow screens scroll the row inside `.table-wrap`.
 */
export function PeriodReturnsTable({
  data,
  displayUnit,
}: {
  data: PeriodReturnsPayload;
  displayUnit: "clp" | "usd";
}) {
  const { t } = useTranslation();
  const formatNominal = displayUnit === "usd" ? formatUsdFine : formatClp;

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

  const header = (
    <thead>
      <tr>
        {data.periods.map((cell) => (
          <th key={cell.period} className={styles.head}>
            {t(PERIOD_LABEL_KEY[cell.period])}
          </th>
        ))}
      </tr>
    </thead>
  );

  return (
    <Table header={header} tableClassName={styles.table}>
      <tr>
        {data.periods.map((cell) => (
          <td key={cell.period} title={cellTitle(cell)}>
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
          </td>
        ))}
      </tr>
    </Table>
  );
}
