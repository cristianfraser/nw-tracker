import type { CSSProperties } from "react";
import { currencyFormatInfo, formatCurrencyFine, formatGroupedDecimal, formatPct, formatPctCompactParts } from "../../format";
import { useTranslation } from "../../i18n";
import type { WatchlistChanges } from "../../types";

/**
 * The heat grid's shared pieces (the watchlist's tables and the rates page's glance): how a
 * row's value prints, the nine return windows' header cells and their tinted cells.
 */

/** A market row's value as the grid prints it. */
export function formatMarketValue(row: { kind?: string; value: number | null; value_currency: string }): string {
  if (row.value == null || !Number.isFinite(row.value)) return "—";
  // A cross rate near 1 (EUR/USD) reads with four decimals, as quoted.
  if (row.kind === "fx_pair" && currencyFormatInfo(row.value_currency).minorDigits > 0) {
    return formatGroupedDecimal(row.value, 4);
  }
  // An index level is points, not money: no currency sign.
  if (row.value_currency === "none") return formatGroupedDecimal(row.value, 2);
  // In the currency's minor digits: pesos whole, dollars and euros with cents.
  return formatCurrencyFine(row.value, row.value_currency);
}

/** The nine windows in the order drawn: the change field, its sort key and its header label. */
export const HEAT_WINDOWS: readonly { field: keyof WatchlistChanges; sortKey: string; labelKey: string }[] = [
  { field: "day_pct", sortKey: "day", labelKey: "watchlist.colDay" },
  { field: "week_pct", sortKey: "week", labelKey: "watchlist.colWeek" },
  { field: "mtd_pct", sortKey: "mtd", labelKey: "watchlist.colMtd" },
  { field: "mom_pct", sortKey: "mom", labelKey: "watchlist.colMom" },
  { field: "ytd_pct", sortKey: "ytd", labelKey: "watchlist.colYtd" },
  { field: "yoy_pct", sortKey: "yoy", labelKey: "watchlist.colYoy" },
  { field: "y3_pct", sortKey: "y3", labelKey: "watchlist.col3y" },
  { field: "y5_pct", sortKey: "y5", labelKey: "watchlist.col5y" },
  { field: "y10_pct", sortKey: "y10", labelKey: "watchlist.col10y" },
];

/** The nine window headers; `sortable` adds the table's sort keys. */
export function HeatHeadCells({ sortable }: { sortable?: boolean }) {
  const { t } = useTranslation();
  return (
    <>
      {HEAT_WINDOWS.map((w) => (
        <th
          key={w.field}
          className="watchlist-heat__head"
          data-sort-key={sortable ? w.sortKey : undefined}
          data-sort-type={sortable ? "number" : undefined}
        >
          {t(w.labelKey)}
        </th>
      ))}
    </>
  );
}

/**
 * How strong a return's tint is, 0–1: log-scaled so a 10-year +10.000 % does not wash out a
 * day's +2 % (full at ±100 %).
 */
function heatLevel(pct: number): number {
  return Math.min(1, Math.log10(1 + Math.abs(pct)) / 2);
}

/** One window of the heat grid: the return, compact, on a tint by its sign and size. */
export function HeatCell({ value }: { value: number | null }) {
  if (value == null || !Number.isFinite(value)) {
    return <td className="watchlist-heat__cell watchlist-heat__cell--none">—</td>;
  }
  // Tinted by the figure shown: a change that rounds to 0,0 % is flat, whichever its sign.
  const { text, sign } = formatPctCompactParts(value);
  const direction = sign > 0 ? "up" : sign < 0 ? "down" : "flat";
  return (
    <td
      className={`watchlist-heat__cell watchlist-heat__cell--${direction}`}
      style={{ "--heat": heatLevel(value).toFixed(3) } as CSSProperties}
      title={formatPct(value, 2)}
    >
      {text}
    </td>
  );
}

/** A row's nine cells, in the header's order. */
export function HeatCells({ changes }: { changes: WatchlistChanges | null | undefined }) {
  return (
    <>
      {HEAT_WINDOWS.map((w) => (
        <HeatCell key={w.field} value={changes?.[w.field] ?? null} />
      ))}
    </>
  );
}
