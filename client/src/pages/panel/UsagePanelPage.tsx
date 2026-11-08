import { useState } from "react";
import { queryShowsLoading } from "../../queries/pageShapeReady";
import { Button } from "@crfrsr/ui";
import { PageGridTile } from "../../components/layout/PageGridTile";
import { Loadable } from "../../components/ui/Loadable";
import { formatDateTimeLabel } from "../../formatDateLabel";
import { formatGroupedDecimal, formatOrDash, formatPct } from "../../format";
import { useTranslation } from "../../i18n";
import { useUsageEndpointTrend, useUsageReport } from "../../queries/hooks";
import type { UsageEndpointTrendPoint, UsageNotFoundPath, UsagePageRow } from "../../types/usage";
import { ColumnTable, type TableColumn } from "../../components/ui/ColumnTable";
import type { UsageEndpointRow, UsageReportWindow } from "../../types";
import { queryLoadError } from "../../queries/pageShapeReady";

const WINDOWS: UsageReportWindow[] = [1, 7, 30, 90];
const COLLAPSED_ROWS = 20;

function formatMs(ms: number | null | undefined): string {
  return formatOrDash(ms, (n) => formatGroupedDecimal(n, n < 10 ? 1 : 0));
}

function formatCount(n: number): string {
  return formatGroupedDecimal(n, 0);
}

function formatShare(share: number | null): string {
  return formatOrDash(share, (s) => formatPct(s * 100, 0));
}

function formatKb(bytes: number | null): string {
  return formatOrDash(bytes, (b) => formatGroupedDecimal(b / 1024, b < 10 * 1024 ? 1 : 0));
}

function endpointLabel(row: { method: string; route: string; params: string }): string {
  return `${row.method} ${row.route}${row.params ? `?${row.params}` : ""}`;
}

/**
 * `/panel/usage`: the primary instance's usage log (server `usageReport.ts`) — most visited
 * pages with how long they took to settle, the slowest endpoints, and the daily trend of the
 * endpoint picked in that table. Everything is aggregated on the server; this page renders rows.
 */
export function UsagePanelPage() {
  const { t } = useTranslation();
  const [days, setDays] = useState<UsageReportWindow>(7);
  const [selected, setSelected] = useState<UsageEndpointRow | null>(null);
  const report = useUsageReport(days);
  const trend = useUsageEndpointTrend(selected, days);
  const data = report.data;
  const loading = queryShowsLoading(report);

  if (queryLoadError(report)) {
    return (
      <p className="error">
        {report.error instanceof Error ? report.error.message : t("common.loadFailed")}
      </p>
    );
  }

  const trendButton = (row: UsageEndpointRow) => (
    <Button variant="link" onClick={() => setSelected(row)} aria-pressed={selected?.key === row.key}>
      {selected?.key === row.key ? t("usage.trendShown") : t("usage.showTrend")}
    </Button>
  );
  const pageColumns: TableColumn<UsagePageRow>[] = [
    {
      key: "route",
      header: t("usage.colPage"),
      className: "mono",
      cell: (row) => (
        <>
          {row.route}
          <NotFoundPaths paths={row.not_found_paths} />
        </>
      ),
      title: (row) => <span className="mono">{row.route}</span>,
    },
    { key: "views", header: t("usage.colViews"), className: "mono", cell: (row) => formatCount(row.views) },
    { key: "p50", header: t("usage.colSettleP50"), className: "mono", cell: (row) => formatMs(row.settle_p50_ms) },
    { key: "p95", header: t("usage.colSettleP95"), className: "mono", cell: (row) => formatMs(row.settle_p95_ms) },
    { key: "max", header: t("usage.colSettleMax"), className: "mono", cell: (row) => formatMs(row.settle_max_ms) },
    { key: "unsettled", header: t("usage.colUnsettled"), className: "mono", cell: (row) => formatCount(row.unsettled_views) },
    {
      key: "queries",
      header: t("usage.colFetchedQueries"),
      className: "mono",
      cell: (row) => formatGroupedDecimal(row.avg_fetched_queries, 1),
    },
    {
      key: "last",
      header: t("usage.colLastViewed"),
      className: "mono",
      cell: (row) => formatDateTimeLabel(new Date(row.last_viewed_at)),
    },
  ];
  const endpointColumns: TableColumn<UsageEndpointRow>[] = [
    {
      key: "endpoint",
      header: t("usage.colEndpoint"),
      className: "mono",
      cell: (row) => (
        <>
          {endpointLabel(row)} {trendButton(row)}
        </>
      ),
      title: (row) => <span className="mono">{endpointLabel(row)}</span>,
    },
    { key: "count", header: t("usage.colCount"), className: "mono", cell: (row) => formatCount(row.count) },
    { key: "p50", header: t("usage.colP50"), className: "mono", cell: (row) => formatMs(row.p50_ms) },
    { key: "p95", header: t("usage.colP95"), className: "mono", cell: (row) => formatMs(row.p95_ms) },
    { key: "max", header: t("usage.colMax"), className: "mono", cell: (row) => formatMs(row.max_ms) },
    {
      key: "total",
      header: t("usage.colTotalTime"),
      className: "mono",
      cell: (row) => formatGroupedDecimal(row.total_ms / 1000, 1),
    },
    { key: "warm", header: t("usage.colWarm"), className: "mono", cell: (row) => formatShare(row.cache_warm_share) },
    { key: "errors", header: t("usage.colErrors"), className: "mono", cell: (row) => errorsCell(row) },
    { key: "size", header: t("usage.colSize"), className: "mono", cell: (row) => formatKb(row.avg_bytes) },
  ];
  const trendColumns: TableColumn<UsageEndpointTrendPoint>[] = [
    { key: "day", header: t("usage.colDay"), className: "mono", cell: (p) => <span className="mono">{p.day}</span>, title: true },
    { key: "count", header: t("usage.colCount"), className: "mono", cell: (p) => formatCount(p.count) },
    { key: "avg", header: t("usage.colAvg"), className: "mono", cell: (p) => formatMs(p.avg_ms) },
    { key: "p50", header: t("usage.colP50"), className: "mono", cell: (p) => formatMs(p.p50_ms) },
    { key: "p95", header: t("usage.colP95"), className: "mono", cell: (p) => formatMs(p.p95_ms) },
    { key: "max", header: t("usage.colMax"), className: "mono", cell: (p) => formatMs(p.max_ms) },
  ];

  const pages = data?.pages ?? [];
  const endpoints = data?.endpoints ?? [];
  const errorsCell = (row: UsageEndpointRow) =>
    `${formatCount(row.server_errors)} / ${formatCount(row.client_errors)}`;

  return (
    <>
      <PageGridTile id="summary">
        <div className="chart-panel-title-row">
          <p className="muted" style={{ margin: 0 }}>
            {data
              ? t("usage.totals", {
                  views: formatCount(data.totals.page_views),
                  requests: formatCount(data.totals.requests),
                  seconds: formatGroupedDecimal(data.totals.request_ms / 1000, 0),
                })
              : " "}
          </p>
          <label style={{ display: "inline-flex", alignItems: "center", gap: "0.35rem" }}>
            <span className="muted">{t("usage.windowLabel")}</span>
            <select
              value={days}
              onChange={(e) => {
                const v = Number(e.target.value);
                const w = WINDOWS.find((x) => x === v);
                if (w !== undefined) setDays(w);
              }}
            >
              {WINDOWS.map((w) => (
                <option key={w} value={w}>
                  {t(`usage.windowOptions.${w}`)}
                </option>
              ))}
            </select>
          </label>
        </div>
        {data && !data.enabled ? <p className="muted">{t("usage.disabled")}</p> : null}
      </PageGridTile>

      <PageGridTile id="pages">
        <h2>{t("usage.pagesTitle")}</h2>
        <Loadable loading={loading}>
          <ColumnTable
            rows={pages}
            columns={pageColumns}
            rowKey={(row) => row.route}
            emptyLabel={t("usage.pagesEmpty")}
            loading={loading}
            cardLead={(row) => <NotFoundPaths paths={row.not_found_paths} />}
            collapsedVisibleRows={COLLAPSED_ROWS}
          />
        </Loadable>
      </PageGridTile>

      <PageGridTile id="endpoints">
        <h2>{t("usage.endpointsTitle")}</h2>
        <p className="muted">{t("usage.endpointsHint")}</p>
        <Loadable loading={loading}>
          <ColumnTable
            rows={endpoints}
            columns={endpointColumns}
            rowKey={(row) => row.key}
            emptyLabel={t("usage.endpointsEmpty")}
            loading={loading}
            cardTail={trendButton}
            collapsedVisibleRows={COLLAPSED_ROWS}
          />
        </Loadable>
      </PageGridTile>

      {selected ? (
        <PageGridTile id="trend">
          <h2>{t("usage.trendTitle")}</h2>
          <p className="muted mono">{endpointLabel(selected)}</p>
          {queryLoadError(trend) ? (
            <p className="error">
              {trend.error instanceof Error ? trend.error.message : t("common.loadFailed")}
            </p>
          ) : (
            <Loadable loading={trend.isPending}>
              <ColumnTable
                rows={(trend.data?.points ?? []).slice().reverse()}
                columns={trendColumns}
                rowKey={(p) => p.day}
              />
            </Loadable>
          )}
        </PageGridTile>
      ) : null}
    </>
  );
}

/** Under the `/404` row: the paths that led there, with how often. */
function NotFoundPaths({ paths }: { paths: UsageNotFoundPath[] | null }) {
  const { t } = useTranslation();
  if (!paths || paths.length === 0) return null;
  return (
    <ul className="muted" style={{ margin: "0.25rem 0 0", paddingLeft: "1rem" }}>
      {paths.map((p) => (
        <li key={p.path} title={t("usage.notFoundPathTitle", { last: formatDateTimeLabel(new Date(p.last_viewed_at)) })}>
          {p.path} ×{formatCount(p.views)}
        </li>
      ))}
    </ul>
  );
}
