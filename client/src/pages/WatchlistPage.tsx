import { Fragment, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { DeltaMetricFlow } from "../components/dashboard/DeltaMetricFlow";
import { Table } from "../components/ui/Table";
import { useDisplayPreferences } from "../context/DisplayPreferencesContext";
import { formatClp, formatGroupedDecimal, formatPct, formatUsdFine } from "../format";
import { useTranslation } from "../i18n";
import {
  useAddWatchlistTicker,
  useDeleteWatchlistRow,
  usePatchWatchlistMarquee,
  useWatchlist,
  useWatchlistSymbolSearch,
} from "../queries/hooks";
import type { WatchlistRow, WatchlistSymbolSearchResult } from "../types";
import { Button, Combobox, CommandItem } from "@crfrsr/ui";

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
  // An index level is points, not money: no currency sign.
  if (row.value_currency === "none") return formatGroupedDecimal(row.value, 2);
  return row.value_currency === "usd" ? formatUsdFine(row.value) : formatClp(row.value);
}

/** Why an equity row has no (or a stale) price: its last Yahoo fetch failed. */
function FetchErrorNote({ error }: { error: NonNullable<WatchlistRow["fetch_error"]> }) {
  const { t } = useTranslation();
  const label = error.stage === "live" ? t("watchlist.fetchErrorLive") : t("watchlist.fetchErrorHistory");
  return (
    <span className="watchlist-table__fetch-error" role="note">
      {label}: {error.message} ({error.failed_at.slice(0, 16).replace("T", " ")} UTC)
    </span>
  );
}

const SEARCH_DEBOUNCE_MS = 300;

/** The add box: Yahoo's matches for what is typed; picking one adds it (the server checks it again). */
function AddSymbolCombobox() {
  const { t } = useTranslation();
  const addTicker = useAddWatchlistTicker();
  const [search, setSearch] = useState("");
  const [debounced, setDebounced] = useState("");
  useEffect(() => {
    const id = setTimeout(() => setDebounced(search.trim()), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(id);
  }, [search]);
  const results = useWatchlistSymbolSearch(debounced);
  const options = debounced ? (results.data?.results ?? []) : [];
  const waiting = search.trim() !== debounced || results.isFetching;

  const emptyMessage = !search.trim()
    ? t("watchlist.searchPrompt")
    : results.isError
      ? results.error instanceof Error
        ? results.error.message
        : t("watchlist.searchError")
      : t("watchlist.searchNoResults");

  return (
    <div className="watchlist-add-form">
      <Combobox<WatchlistSymbolSearchResult>
        options={options}
        filteredOptions={options}
        isLoading={waiting && search.trim().length > 0}
        searchValue={search}
        onSearchChange={setSearch}
        onSelect={(option) => {
          if (!option.on_watchlist) addTicker.mutate(option.symbol);
        }}
        trigger={
          <Button type="button" variant="outline" disabled={addTicker.isPending}>
            {addTicker.isPending ? t("watchlist.adding") : t("watchlist.addTickerLabel")}
          </Button>
        }
        placeholder={t("watchlist.searchPlaceholder")}
        emptyMessage={emptyMessage}
        loadingMessage={t("common.loading")}
        popoverWidth="26rem"
        estimateItemSize={44}
        renderOption={(option, _index, onSelect) => (
          <CommandItem
            value={option.symbol}
            onSelect={onSelect}
            disabled={option.on_watchlist}
            className="watchlist-symbol-option"
          >
            <span className="watchlist-symbol-option__symbol mono">{option.symbol}</span>
            <span className="watchlist-symbol-option__detail">
              <span className="watchlist-symbol-option__name">{option.name ?? "—"}</span>
              <span className="watchlist-symbol-option__meta muted">
                {[option.type, option.exchange].filter(Boolean).join(" · ")}
                {option.on_watchlist ? ` · ${t("watchlist.alreadyListed")}` : ""}
              </span>
            </span>
          </CommandItem>
        )}
      />
      {addTicker.isError ? (
        <p className="error" role="alert">
          {addTicker.error instanceof Error ? addTicker.error.message : t("watchlist.addError")}
        </p>
      ) : null}
    </div>
  );
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
  row: Pick<WatchlistRow, "value" | "value_currency" | "changes"> & {
    fetch_error?: WatchlistRow["fetch_error"];
  };
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
      <td className={symbolClassName ?? "watchlist-table__symbol mono"}>
        {symbol}
        {row.fetch_error ? <FetchErrorNote error={row.fetch_error} /> : null}
      </td>
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
              <Button variant="ghost"
                disabled={deleteRow.isPending}
                onClick={() => deleteRow.mutate(row.id)}
              >
                {t("watchlist.removeTicker")}
              </Button>
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
                const weightPct = formatPct(holding.weight * 100, 1);
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
  // Prices and changes follow the CLP/USD toggle (converted server-side, unit in the query key).
  const { displayUnit } = useDisplayPreferences();
  const { data, isPending, error } = useWatchlist(displayUnit);
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

      <section className="watchlist-section">
        <h2>{t("watchlist.appSectionTitle")}</h2>
        <WatchlistTable rows={data.app} expandCompositeHoldings />
      </section>

      <section className="watchlist-section">
        <h2>{t("watchlist.manualSectionTitle")}</h2>
        <AddSymbolCombobox />
        <WatchlistTable rows={data.manual} showActions />
      </section>
    </main>
  );
}
