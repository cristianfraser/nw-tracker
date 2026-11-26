import { useState, type ReactNode } from "react";
import { queryLoadError, queryShowsLoading } from "../../queries/pageShapeReady";
import { Button } from "@crfrsr/ui";
import { PageGridTile } from "../../components/layout/PageGridTile";
import { Loadable } from "../../components/ui/Loadable";
import { OpenRow, OpenRows, RowFacts } from "../../components/ui/OpenRows";
import { formatDateTimeLabel } from "../../formatDateLabel";
import { formatGroupedDecimal, formatOrDash, formatPct } from "../../format";
import { useTranslation } from "../../i18n";
import { useUsageEndpointTrend, useUsageReport } from "../../queries/hooks";
import type { UsageNotFoundPath, UsagePageRow } from "../../types/usage";
import type { UsageEndpointRow, UsageReportWindow } from "../../types";
import styles from "./UsagePanelPage.module.css";

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

/** The parts of a row's muted line, joined with a middle dot. */
function joinParts(parts: (string | null)[]): string {
  return parts.filter((p) => p != null).join(" · ");
}

/**
 * `/panel/usage`: the primary instance's usage log (server `usageReport.ts`) — most visited
 * pages with how long they took to settle, and the slowest endpoints. Both lists are the rows of
 * the import sync panels (`OpenRows`): the name, the figure the list is ordered by, a muted line
 * with the next few figures; a row opens into all of them, an endpoint also into its daily trend.
 * Everything is aggregated on the server; this page renders rows.
 */
export function UsagePanelPage() {
  const { t } = useTranslation();
  const [days, setDays] = useState<UsageReportWindow>(7);
  const report = useUsageReport(days);
  const data = report.data;
  const loading = queryShowsLoading(report);

  if (queryLoadError(report)) {
    return (
      <p className="error">
        {report.error instanceof Error ? report.error.message : t("common.loadFailed")}
      </p>
    );
  }

  const pages = data?.pages ?? [];
  const endpoints = data?.endpoints ?? [];

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
              : " "}
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
        <UsageRows loading={loading} count={pages.length} emptyLabel={t("usage.pagesEmpty")}>
          {(shown) => pages.slice(0, shown).map((row) => <PageRow key={row.route} row={row} />)}
        </UsageRows>
      </PageGridTile>

      <PageGridTile id="endpoints">
        <h2>{t("usage.endpointsTitle")}</h2>
        <p className={`muted ${styles.hint}`}>{t("usage.endpointsHint")}</p>
        <UsageRows loading={loading} count={endpoints.length} emptyLabel={t("usage.endpointsEmpty")}>
          {(shown) => endpoints.slice(0, shown).map((row) => <EndpointRow key={row.key} row={row} days={days} />)}
        </UsageRows>
      </PageGridTile>
    </>
  );
}

/** A list's frame: its first rows, then «Show more…» for the rest. */
function UsageRows({
  loading,
  count,
  emptyLabel,
  children,
}: {
  loading: boolean;
  count: number;
  emptyLabel: string;
  children: (shown: number) => ReactNode;
}) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const hasHidden = count > COLLAPSED_ROWS;
  return (
    <>
      <OpenRows loading={loading} empty={count === 0 && !loading ? emptyLabel : undefined}>
        {children(hasHidden && !expanded ? COLLAPSED_ROWS : count)}
      </OpenRows>
      {hasHidden ? (
        <Button variant="ghost" onClick={() => setExpanded((e) => !e)}>
          {expanded ? t("importSync.showLess") : t("importSync.showMore")}
        </Button>
      ) : null}
    </>
  );
}

/** The figure a list is ordered by, right-aligned in its own column. */
function Figure({ children }: { children: ReactNode }) {
  return <span className={styles.figure}>{children}</span>;
}

function PageRow({ row }: { row: UsagePageRow }) {
  const { t } = useTranslation();
  const paths = row.not_found_paths;
  return (
    <OpenRow
      title={<span className="mono">{row.route}</span>}
      status={
        <Figure>
          {/* The bare figure is the row's views: say so in the toggle's name. */}
          <span className="visually-hidden">{`${t("usage.colViews")} `}</span>
          {formatCount(row.views)}
        </Figure>
      }
      first={joinParts([
        row.settle_p50_ms != null ? t("usage.lineP50", { ms: formatMs(row.settle_p50_ms) }) : null,
        row.settle_p95_ms != null ? t("usage.lineP95", { ms: formatMs(row.settle_p95_ms) }) : null,
        row.unsettled_views > 0 ? t("usage.lineUnsettled", { count: formatCount(row.unsettled_views) }) : null,
        paths && paths.length > 0 ? t("usage.linePaths", { count: formatCount(paths.length) }) : null,
      ])}
    >
      <RowFacts
        facts={[
          [t("usage.colViews"), formatCount(row.views)],
          [t("usage.colSettleP50"), formatMs(row.settle_p50_ms)],
          [t("usage.colSettleP95"), formatMs(row.settle_p95_ms)],
          [t("usage.colSettleMax"), formatMs(row.settle_max_ms)],
          [t("usage.colUnsettled"), formatCount(row.unsettled_views)],
          [t("usage.colFetchedQueries"), formatGroupedDecimal(row.avg_fetched_queries, 1)],
          [t("usage.colLastViewed"), formatDateTimeLabel(new Date(row.last_viewed_at))],
          [t("usage.colPaths"), paths && paths.length > 0 ? <NotFoundPaths paths={paths} /> : null],
        ]}
      />
    </OpenRow>
  );
}

function EndpointRow({ row, days }: { row: UsageEndpointRow; days: UsageReportWindow }) {
  const { t } = useTranslation();
  const errors = `${formatCount(row.server_errors)} / ${formatCount(row.client_errors)}`;
  return (
    <OpenRow
      title={<span className="mono">{endpointLabel(row)}</span>}
      status={<Figure>{t("usage.lineMs", { ms: formatMs(row.p95_ms) })}</Figure>}
      first={joinParts([
        t("usage.lineRequests", { count: formatCount(row.count) }),
        row.p50_ms != null ? t("usage.lineP50", { ms: formatMs(row.p50_ms) }) : null,
        t("usage.lineTotal", { seconds: formatGroupedDecimal(row.total_ms / 1000, 1) }),
        row.server_errors > 0 || row.client_errors > 0 ? t("usage.lineErrors", { errors }) : null,
      ])}
    >
      <RowFacts
        facts={[
          [t("usage.colCount"), formatCount(row.count)],
          [t("usage.colP50"), formatMs(row.p50_ms)],
          [t("usage.colP95"), formatMs(row.p95_ms)],
          [t("usage.colMax"), formatMs(row.max_ms)],
          [t("usage.colTotalTime"), formatGroupedDecimal(row.total_ms / 1000, 1)],
          [t("usage.colWarm"), formatShare(row.cache_warm_share)],
          [t("usage.colErrors"), errors],
          [t("usage.colSize"), formatKb(row.avg_bytes)],
        ]}
      />
      <EndpointTrend row={row} days={days} />
    </OpenRow>
  );
}

/** An open endpoint's daily trend: mounted with the row's body, so it is fetched on opening. */
function EndpointTrend({ row, days }: { row: UsageEndpointRow; days: UsageReportWindow }) {
  const { t } = useTranslation();
  const trend = useUsageEndpointTrend(row, days);
  if (queryLoadError(trend)) {
    return <p className="error">{trend.error instanceof Error ? trend.error.message : t("common.loadFailed")}</p>;
  }
  const points = (trend.data?.points ?? []).slice().reverse();
  return (
    <Loadable loading={trend.isPending}>
      <table className={styles.trend}>
        <caption>{t("usage.trendTitle")}</caption>
        <thead>
          <tr>
            <th scope="col">{t("usage.colDay")}</th>
            <th scope="col">{t("usage.colCount")}</th>
            <th scope="col">{t("usage.trendAvg")}</th>
            <th scope="col">{t("usage.trendP50")}</th>
            <th scope="col">{t("usage.trendP95")}</th>
            <th scope="col">{t("usage.trendMax")}</th>
          </tr>
        </thead>
        <tbody>
          {points.map((p) => (
            <tr key={p.day}>
              <th scope="row">{p.day}</th>
              <td>{formatCount(p.count)}</td>
              <td>{formatMs(p.avg_ms)}</td>
              <td>{formatMs(p.p50_ms)}</td>
              <td>{formatMs(p.p95_ms)}</td>
              <td>{formatMs(p.max_ms)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Loadable>
  );
}

/** In the open `/404` row: the paths that led there, with how often. */
function NotFoundPaths({ paths }: { paths: UsageNotFoundPath[] }) {
  const { t } = useTranslation();
  return (
    <ul className={styles.paths}>
      {paths.map((p) => (
        <li key={p.path} title={t("usage.notFoundPathTitle", { last: formatDateTimeLabel(new Date(p.last_viewed_at)) })}>
          <span className="mono">{p.path}</span> ×{formatCount(p.views)}
        </li>
      ))}
    </ul>
  );
}
