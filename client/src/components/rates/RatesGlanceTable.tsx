import { loadableClass } from "../ui/Loadable";
import { Table } from "../ui/Table";
import { useTranslation } from "../../i18n";
import type { RatesGlanceRow } from "../../types";
import { formatMarketValue, HeatCells, HeatHeadCells } from "../watchlist/heatGrid";
import { ratesRowLabel } from "./ratesSeries";

/**
 * The rates page's glance: the watchlist's heat grid with one row per series — today's value and
 * its change over the nine windows — and no marquee checkbox. Same phone behaviour as the
 * watchlist's: the windows scroll inside the grid under the pinned name.
 */
export function RatesGlanceTable({
  rows,
  nameLabel,
  loading,
}: {
  rows: readonly RatesGlanceRow[];
  /** The first column's header («Pair», «Instrument»). */
  nameLabel: string;
  loading?: boolean;
}) {
  const { t } = useTranslation();
  return (
    <Table
      tableClassName="watchlist-table"
      wrapClassName={loadableClass(loading, "watchlist-table-wrap", "watchlist-table-wrap--no-marquee")}
      header={
        <thead>
          <tr>
            <th className="watchlist-table__symbol">{nameLabel}</th>
            <th className="watchlist-table__price">{t("rates.glance.colToday")}</th>
            <HeatHeadCells />
          </tr>
        </thead>
      }
    >
      {rows.map((row) => (
        <tr key={row.id}>
          <td className="watchlist-table__symbol mono">
            <span className="watchlist-table__symbol-text">{ratesRowLabel(row, t)}</span>
          </td>
          <td
            className="watchlist-table__price mono"
            title={row.as_of_date != null ? t("rates.glance.asOf", { date: row.as_of_date }) : undefined}
          >
            {formatMarketValue(row)}
          </td>
          <HeatCells changes={row.changes} />
        </tr>
      ))}
    </Table>
  );
}
