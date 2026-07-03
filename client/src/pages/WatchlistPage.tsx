import { FormEvent, Fragment, useState } from "react";
import { Link } from "react-router-dom";
import { DeltaMetricFlow } from "../components/dashboard/DeltaMetricFlow";
import { Table } from "../components/ui/Table";
import { formatClp, formatUsdFine } from "../format";
import { useTranslation } from "../i18n";
import {
  useAddWatchlistTicker,
  useDeleteWatchlistRow,
  usePatchWatchlistMarquee,
  useWatchlist,
} from "../queries/hooks";
import type { WatchlistRow } from "../types";

function symbolLabel(row: WatchlistRow, t: (key: string) => string): string {
  if (row.label_i18n_key) {
    const translated = t(row.label_i18n_key);
    if (translated !== row.label_i18n_key) return translated;
  }
  if (row.kind === "equity" && row.series_key) return row.series_key;
  return row.label;
}

function formatPriceRow(row: Pick<WatchlistRow, "value" | "value_currency">): string {
  if (row.value == null || !Number.isFinite(row.value)) return "—";
  return row.value_currency === "usd" ? formatUsdFine(row.value) : formatClp(row.value);
}

function PctCell({
  value,
  seedId,
  col,
}: {
  value: number | null;
  seedId: string;
  col: string;
}) {
  return (
    <DeltaMetricFlow
      delta={value}
      deltaFormat="percent"
      fractionDigits={2}
      mountSeedId={`${seedId}-${col}`}
    />
  );
}

function watchlistTr({
  row,
  symbol,
  symbolClassName,
  marquee,
  actions,
  showActionsColumn,
  sortSeed,
}: {
  row: Pick<WatchlistRow, "value" | "value_currency" | "changes">;
  symbol: string;
  symbolClassName?: string;
  marquee?: React.ReactNode;
  actions?: React.ReactNode;
  showActionsColumn?: boolean;
  sortSeed: string;
}) {
  const changes = row.changes;
  return (
    <tr
      data-sort-symbol={symbol}
      data-sort-price={row.value ?? ""}
      data-sort-day={changes?.day_pct ?? ""}
      data-sort-week={changes?.week_pct ?? ""}
      data-sort-mtd={changes?.mtd_pct ?? ""}
      data-sort-mom={changes?.mom_pct ?? ""}
      data-sort-ytd={changes?.ytd_pct ?? ""}
      data-sort-yoy={changes?.yoy_pct ?? ""}
      data-sort-y3={changes?.y3_pct ?? ""}
      data-sort-y5={changes?.y5_pct ?? ""}
      data-sort-y10={changes?.y10_pct ?? ""}
    >
      <td className="watchlist-table__marquee">{marquee ?? null}</td>
      <td className={symbolClassName ?? "watchlist-table__symbol mono"}>{symbol}</td>
      <td className="watchlist-table__num mono">{formatPriceRow(row)}</td>
      <td className="watchlist-table__num">
        <PctCell value={changes?.day_pct ?? null} seedId={sortSeed} col="day" />
      </td>
      <td className="watchlist-table__num">
        <PctCell value={changes?.week_pct ?? null} seedId={sortSeed} col="week" />
      </td>
      <td className="watchlist-table__num">
        <PctCell value={changes?.mtd_pct ?? null} seedId={sortSeed} col="mtd" />
      </td>
      <td className="watchlist-table__num">
        <PctCell value={changes?.mom_pct ?? null} seedId={sortSeed} col="mom" />
      </td>
      <td className="watchlist-table__num">
        <PctCell value={changes?.ytd_pct ?? null} seedId={sortSeed} col="ytd" />
      </td>
      <td className="watchlist-table__num">
        <PctCell value={changes?.yoy_pct ?? null} seedId={sortSeed} col="yoy" />
      </td>
      <td className="watchlist-table__num">
        <PctCell value={changes?.y3_pct ?? null} seedId={sortSeed} col="y3" />
      </td>
      <td className="watchlist-table__num">
        <PctCell value={changes?.y5_pct ?? null} seedId={sortSeed} col="y5" />
      </td>
      <td className="watchlist-table__num">
        <PctCell value={changes?.y10_pct ?? null} seedId={sortSeed} col="y10" />
      </td>
      {showActionsColumn ? <td className="watchlist-table__actions">{actions ?? null}</td> : null}
    </tr>
  );
}

function WatchlistTable({
  rows,
  showActions,
  expandCompositeHoldings,
}: {
  rows: WatchlistRow[];
  showActions?: boolean;
  expandCompositeHoldings?: boolean;
}) {
  const { t } = useTranslation();
  const patchMarquee = usePatchWatchlistMarquee();
  const deleteRow = useDeleteWatchlistRow();

  if (rows.length === 0) {
    return showActions ? <p className="muted">{t("watchlist.emptyManual")}</p> : null;
  }

  return (
    <Table
      tableClassName="watchlist-table"
      wrapClassName="watchlist-table-wrap"
      header={
        <thead>
          <tr>
            <th className="watchlist-table__marquee">{t("watchlist.colMarquee")}</th>
            <th className="watchlist-table__symbol" data-sort-key="symbol" data-sort-type="string">
              {t("watchlist.colSymbol")}
            </th>
            <th className="watchlist-table__num" data-sort-key="price" data-sort-type="number">
              {t("watchlist.colPrice")}
            </th>
            <th className="watchlist-table__num" data-sort-key="day" data-sort-type="number">
              {t("watchlist.colDay")}
            </th>
            <th className="watchlist-table__num" data-sort-key="week" data-sort-type="number">
              {t("watchlist.colWeek")}
            </th>
            <th className="watchlist-table__num" data-sort-key="mtd" data-sort-type="number">
              {t("watchlist.colMtd")}
            </th>
            <th className="watchlist-table__num" data-sort-key="mom" data-sort-type="number">
              {t("watchlist.colMom")}
            </th>
            <th className="watchlist-table__num" data-sort-key="ytd" data-sort-type="number">
              {t("watchlist.colYtd")}
            </th>
            <th className="watchlist-table__num" data-sort-key="yoy" data-sort-type="number">
              {t("watchlist.colYoy")}
            </th>
            <th className="watchlist-table__num" data-sort-key="y3" data-sort-type="number">
              {t("watchlist.col3y")}
            </th>
            <th className="watchlist-table__num" data-sort-key="y5" data-sort-type="number">
              {t("watchlist.col5y")}
            </th>
            <th className="watchlist-table__num" data-sort-key="y10" data-sort-type="number">
              {t("watchlist.col10y")}
            </th>
            {showActions ? <th className="watchlist-table__actions">{t("watchlist.colActions")}</th> : null}
          </tr>
        </thead>
      }
    >
      {rows.map((row) => (
        <Fragment key={row.id}>
          {watchlistTr({
            row,
            symbol: symbolLabel(row, t),
            sortSeed: `wl-${row.id}`,
            showActionsColumn: showActions,
            actions: showActions ? (
              <button
                type="button"
                className="btn btn--ghost"
                disabled={deleteRow.isPending}
                onClick={() => deleteRow.mutate(row.id)}
              >
                {t("watchlist.removeTicker")}
              </button>
            ) : undefined,
            marquee: (
              <label style={{ display: "inline-flex", alignItems: "center" }}>
                <input
                  type="checkbox"
                  checked={row.show_in_marquee === 1}
                  disabled={patchMarquee.isPending}
                  aria-label={t("watchlist.marqueeAria")}
                  onChange={(e) =>
                    patchMarquee.mutate({
                      id: row.id,
                      show_in_marquee: e.target.checked ? 1 : 0,
                    })
                  }
                />
              </label>
            ),
          })}
          {expandCompositeHoldings && row.kind === "composite" && row.composite_holdings?.length
            ? row.composite_holdings.map((holding) => {
                const weightPct = `${(holding.weight * 100).toFixed(1)}%`;
                return (
                  <Fragment key={`${row.id}-${holding.ticker}`}>
                    {watchlistTr({
                      row: holding,
                      symbol: `${holding.ticker} · ${weightPct}`,
                      symbolClassName: "watchlist-table__symbol watchlist-table__symbol--sub mono",
                      sortSeed: `wl-${row.id}-h-${holding.ticker}`,
                      showActionsColumn: showActions,
                    })}
                  </Fragment>
                );
              })
            : null}
        </Fragment>
      ))}
    </Table>
  );
}

export function WatchlistPage() {
  const { t } = useTranslation();
  const { data, isPending, error } = useWatchlist();
  const addTicker = useAddWatchlistTicker();
  const [tickerInput, setTickerInput] = useState("");

  const onAdd = (e: FormEvent) => {
    e.preventDefault();
    const raw = tickerInput.trim();
    if (!raw) return;
    addTicker.mutate(raw, {
      onSuccess: () => setTickerInput(""),
    });
  };

  if (error) {
    return (
      <main>
        <p className="muted">
          <Link to="/">{t("common.backToDashboard")}</Link>
        </p>
        <h1>{t("watchlist.pageTitle")}</h1>
        <p className="error">{error instanceof Error ? error.message : String(error)}</p>
      </main>
    );
  }

  if (isPending || !data) {
    return (
      <main>
        <p className="muted">
          <Link to="/">{t("common.backToDashboard")}</Link>
        </p>
        <h1>{t("watchlist.pageTitle")}</h1>
        <p className="muted">{t("common.loading")}</p>
      </main>
    );
  }

  return (
    <main className="watchlist-page">
      <p className="muted">
        <Link to="/">{t("common.backToDashboard")}</Link>
      </p>
      <h1>{t("watchlist.pageTitle")}</h1>
      <p className="muted">{t("watchlist.pageHint")}</p>

      <section className="watchlist-section">
        <h2>{t("watchlist.appSectionTitle")}</h2>
        <WatchlistTable rows={data.app} expandCompositeHoldings />
      </section>

      <section className="watchlist-section">
        <h2>{t("watchlist.manualSectionTitle")}</h2>
        <form className="watchlist-add-form" onSubmit={onAdd}>
          <label>
            <span>{t("watchlist.addTickerLabel")}</span>
            <input
              type="text"
              value={tickerInput}
              onChange={(e) => setTickerInput(e.target.value)}
              placeholder={t("watchlist.addTickerPlaceholder")}
              className="mono"
              autoCapitalize="characters"
              spellCheck={false}
            />
          </label>
          <button type="submit" className="btn" disabled={addTicker.isPending || !tickerInput.trim()}>
            {t("watchlist.addTickerSubmit")}
          </button>
        </form>
        {addTicker.isError ? (
          <p className="error" role="alert">
            {addTicker.error instanceof Error ? addTicker.error.message : t("watchlist.addError")}
          </p>
        ) : null}
        <WatchlistTable rows={data.manual} showActions />
      </section>
    </main>
  );
}
