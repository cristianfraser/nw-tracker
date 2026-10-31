import { useState } from "react";
import { Button } from "@crfrsr/ui";
import { Loadable } from "../../components/ui/Loadable";
import { Table } from "../../components/ui/Table";
import {
  TableMobileCard,
  TableMobileCardRow,
  TableMobileCardSection,
} from "../../components/ui/TableMobileCard";
import { formatDateTimeLabel } from "../../formatDateLabel";
import { formatGroupedDecimal, formatOrDash, formatPct } from "../../format";
import { useTranslation } from "../../i18n";
import { useUsageEndpointTrend, useUsageReport } from "../../queries/hooks";
import type { UsageEndpointRow, UsageReportWindow } from "../../types";

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
  const loading = report.isPending || report.isPlaceholderData;

  if (report.isError) {
    return (
      <p className="error">
        {report.error instanceof Error ? report.error.message : t("common.loadFailed")}
      </p>
    );
  }

  const pagesHeader = (
    <thead>
      <tr>
        <th className="desktop-only">{t("usage.colPage")}</th>
        <th className="desktop-only">{t("usage.colViews")}</th>
        <th className="desktop-only">{t("usage.colSettleP50")}</th>
        <th className="desktop-only">{t("usage.colSettleP95")}</th>
        <th className="desktop-only">{t("usage.colSettleMax")}</th>
        <th className="desktop-only">{t("usage.colUnsettled")}</th>
        <th className="desktop-only">{t("usage.colFetchedQueries")}</th>
        <th className="desktop-only">{t("usage.colLastViewed")}</th>
        <th className="mobile-only" aria-hidden="true" />
      </tr>
    </thead>
  );

  const endpointsHeader = (
    <thead>
      <tr>
        <th className="desktop-only">{t("usage.colEndpoint")}</th>
        <th className="desktop-only">{t("usage.colCount")}</th>
        <th className="desktop-only">{t("usage.colP50")}</th>
        <th className="desktop-only">{t("usage.colP95")}</th>
        <th className="desktop-only">{t("usage.colMax")}</th>
        <th className="desktop-only">{t("usage.colTotalTime")}</th>
        <th className="desktop-only">{t("usage.colWarm")}</th>
        <th className="desktop-only">{t("usage.colErrors")}</th>
        <th className="desktop-only">{t("usage.colSize")}</th>
        <th className="mobile-only" aria-hidden="true" />
      </tr>
    </thead>
  );

  const trendHeader = (
    <thead>
      <tr>
        <th className="desktop-only">{t("usage.colDay")}</th>
        <th className="desktop-only">{t("usage.colCount")}</th>
        <th className="desktop-only">{t("usage.colAvg")}</th>
        <th className="desktop-only">{t("usage.colP50")}</th>
        <th className="desktop-only">{t("usage.colP95")}</th>
        <th className="desktop-only">{t("usage.colMax")}</th>
        <th className="mobile-only" aria-hidden="true" />
      </tr>
    </thead>
  );

  const pages = data?.pages ?? [];
  const endpoints = data?.endpoints ?? [];
  const errorsCell = (row: UsageEndpointRow) =>
    `${formatCount(row.server_errors)} / ${formatCount(row.client_errors)}`;

  return (
    <>
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

      <section style={{ marginTop: "1.5rem" }}>
        <h2>{t("usage.pagesTitle")}</h2>
        <Loadable loading={loading}>
          <Table
            header={pagesHeader}
            tableClassName="table--parallel-mobile"
            collapsedVisibleRows={COLLAPSED_ROWS}
          >
            {pages.length === 0 && !loading ? (
              <tr>
                <td colSpan={9} className="muted">
                  {t("usage.pagesEmpty")}
                </td>
              </tr>
            ) : (
              pages.map((row) => (
                <tr key={row.route}>
                  <td className="desktop-only mono">{row.route}</td>
                  <td className="desktop-only mono">{formatCount(row.views)}</td>
                  <td className="desktop-only mono">{formatMs(row.settle_p50_ms)}</td>
                  <td className="desktop-only mono">{formatMs(row.settle_p95_ms)}</td>
                  <td className="desktop-only mono">{formatMs(row.settle_max_ms)}</td>
                  <td className="desktop-only mono">{formatCount(row.unsettled_views)}</td>
                  <td className="desktop-only mono">{formatGroupedDecimal(row.avg_fetched_queries, 1)}</td>
                  <td className="desktop-only mono">{formatDateTimeLabel(new Date(row.last_viewed_at))}</td>
                  <td className="mobile-only">
                    <TableMobileCard title={<span className="mono">{row.route}</span>}>
                      <TableMobileCardSection>
                        <TableMobileCardRow label={t("usage.colViews")} value={formatCount(row.views)} />
                        <TableMobileCardRow label={t("usage.colSettleP50")} value={formatMs(row.settle_p50_ms)} />
                        <TableMobileCardRow label={t("usage.colSettleP95")} value={formatMs(row.settle_p95_ms)} />
                        <TableMobileCardRow label={t("usage.colSettleMax")} value={formatMs(row.settle_max_ms)} />
                        <TableMobileCardRow label={t("usage.colUnsettled")} value={formatCount(row.unsettled_views)} />
                        <TableMobileCardRow
                          label={t("usage.colFetchedQueries")}
                          value={formatGroupedDecimal(row.avg_fetched_queries, 1)}
                        />
                        <TableMobileCardRow
                          label={t("usage.colLastViewed")}
                          value={formatDateTimeLabel(new Date(row.last_viewed_at))}
                        />
                      </TableMobileCardSection>
                    </TableMobileCard>
                  </td>
                </tr>
              ))
            )}
          </Table>
        </Loadable>
      </section>

      <section style={{ marginTop: "2rem" }}>
        <h2>{t("usage.endpointsTitle")}</h2>
        <p className="muted">{t("usage.endpointsHint")}</p>
        <Loadable loading={loading}>
          <Table
            header={endpointsHeader}
            tableClassName="table--parallel-mobile"
            collapsedVisibleRows={COLLAPSED_ROWS}
          >
            {endpoints.length === 0 && !loading ? (
              <tr>
                <td colSpan={10} className="muted">
                  {t("usage.endpointsEmpty")}
                </td>
              </tr>
            ) : (
              endpoints.map((row) => {
                const trendButton = (
                  <Button
                    variant="link"
                    onClick={() => setSelected(row)}
                    aria-pressed={selected?.key === row.key}
                  >
                    {selected?.key === row.key ? t("usage.trendShown") : t("usage.showTrend")}
                  </Button>
                );
                return (
                  <tr key={row.key}>
                    <td className="desktop-only mono">
                      {endpointLabel(row)} {trendButton}
                    </td>
                    <td className="desktop-only mono">{formatCount(row.count)}</td>
                    <td className="desktop-only mono">{formatMs(row.p50_ms)}</td>
                    <td className="desktop-only mono">{formatMs(row.p95_ms)}</td>
                    <td className="desktop-only mono">{formatMs(row.max_ms)}</td>
                    <td className="desktop-only mono">{formatGroupedDecimal(row.total_ms / 1000, 1)}</td>
                    <td className="desktop-only mono">{formatShare(row.cache_warm_share)}</td>
                    <td className="desktop-only mono">{errorsCell(row)}</td>
                    <td className="desktop-only mono">{formatKb(row.avg_bytes)}</td>
                    <td className="mobile-only">
                      <TableMobileCard title={<span className="mono">{endpointLabel(row)}</span>}>
                        <TableMobileCardSection>
                          <TableMobileCardRow label={t("usage.colCount")} value={formatCount(row.count)} />
                          <TableMobileCardRow label={t("usage.colP50")} value={formatMs(row.p50_ms)} />
                          <TableMobileCardRow label={t("usage.colP95")} value={formatMs(row.p95_ms)} />
                          <TableMobileCardRow label={t("usage.colMax")} value={formatMs(row.max_ms)} />
                          <TableMobileCardRow
                            label={t("usage.colTotalTime")}
                            value={formatGroupedDecimal(row.total_ms / 1000, 1)}
                          />
                          <TableMobileCardRow label={t("usage.colWarm")} value={formatShare(row.cache_warm_share)} />
                          <TableMobileCardRow label={t("usage.colErrors")} value={errorsCell(row)} />
                          <TableMobileCardRow label={t("usage.colSize")} value={formatKb(row.avg_bytes)} />
                        </TableMobileCardSection>
                        {trendButton}
                      </TableMobileCard>
                    </td>
                  </tr>
                );
              })
            )}
          </Table>
        </Loadable>
      </section>

      {selected ? (
        <section style={{ marginTop: "2rem" }}>
          <h2>{t("usage.trendTitle")}</h2>
          <p className="muted mono">{endpointLabel(selected)}</p>
          {trend.isError ? (
            <p className="error">
              {trend.error instanceof Error ? trend.error.message : t("common.loadFailed")}
            </p>
          ) : (
            <Loadable loading={trend.isPending}>
              <Table header={trendHeader} tableClassName="table--parallel-mobile">
                {(trend.data?.points ?? [])
                  .slice()
                  .reverse()
                  .map((p) => (
                    <tr key={p.day}>
                      <td className="desktop-only mono">{p.day}</td>
                      <td className="desktop-only mono">{formatCount(p.count)}</td>
                      <td className="desktop-only mono">{formatMs(p.avg_ms)}</td>
                      <td className="desktop-only mono">{formatMs(p.p50_ms)}</td>
                      <td className="desktop-only mono">{formatMs(p.p95_ms)}</td>
                      <td className="desktop-only mono">{formatMs(p.max_ms)}</td>
                      <td className="mobile-only">
                        <TableMobileCard title={<span className="mono">{p.day}</span>}>
                          <TableMobileCardSection>
                            <TableMobileCardRow label={t("usage.colCount")} value={formatCount(p.count)} />
                            <TableMobileCardRow label={t("usage.colAvg")} value={formatMs(p.avg_ms)} />
                            <TableMobileCardRow label={t("usage.colP50")} value={formatMs(p.p50_ms)} />
                            <TableMobileCardRow label={t("usage.colP95")} value={formatMs(p.p95_ms)} />
                            <TableMobileCardRow label={t("usage.colMax")} value={formatMs(p.max_ms)} />
                          </TableMobileCardSection>
                        </TableMobileCard>
                      </td>
                    </tr>
                  ))}
              </Table>
            </Loadable>
          )}
        </section>
      ) : null}
    </>
  );
}
