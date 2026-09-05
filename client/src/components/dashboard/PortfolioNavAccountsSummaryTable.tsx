import { useMemo } from "react";
import { Link } from "react-router-dom";
import {
  cardGroupMetricsByPeriodFromAccounts,
  compareDashboardCardMainDesc,
  roundedMetricDelta,
  roundedMetricDeposits,
  sumCurrentValueClpUsd,
  type CardGroupMetricsByPeriod,
} from "../../dashboardCardBreakdown";
import { formatPct } from "../../format";
import { useTranslation } from "../../i18n";
import { dashboardRowsForNavSubtree } from "../../portfolioNavDashboardCards";
import { resolveNavTreeLabel } from "../../sidebarNavFromApi";
import type { DashboardAccountRow, DashboardResponse, NavTreeNodeDto } from "../../types";
import { cardDeltaFractionDigits, DepositedMetricFlow } from "./DashboardCardGroupMetrics";
import { DashboardCardValue } from "./DashboardCardValue";
import { DeltaMetricFlow } from "./DeltaMetricFlow";
import { Table } from "../ui/Table";
import {
  TableMobileCard,
  TableMobileCardRow,
  TableMobileCardSection,
} from "../ui/TableMobileCard";

export type PortfolioNavAccountsSummaryTableProps = {
  dash: Pick<DashboardResponse, "accounts">;
  navChildren: NavTreeNodeDto[];
  showUsd: boolean;
  animated?: boolean;
  placeholderPhase?: boolean;
};

type PeriodSlice = "day" | "month" | "year" | "total";
type CellVariant = "desktop" | "mobile";

type AccountTableRow = {
  child: NavTreeNodeDto;
  label: string;
  routePath: string;
  clp: number;
  apiUsd: number | null;
  metricsByPeriod: CardGroupMetricsByPeriod;
  /** The single dashboard row behind this leaf (server pct fields); null when ambiguous. */
  single: DashboardAccountRow | null;
  fxMissing: boolean;
  syncStale: boolean;
};

function rowPct(
  row: DashboardAccountRow | null,
  slice: PeriodSlice,
  showUsd: boolean
): number | null {
  if (!row) return null;
  const v = showUsd
    ? {
        day: row.pct_day_usd,
        month: row.pct_month_usd,
        year: row.pct_year_usd,
        total: row.pct_total_usd,
      }[slice]
    : {
        day: row.pct_day_clp,
        month: row.pct_month_clp,
        year: row.pct_year_clp,
        total: row.pct_total_clp,
      }[slice];
  return v != null && Number.isFinite(v) ? v : null;
}

/**
 * Leaf-bucket account summary: one row per account leaf, replacing the old per-account
 * compact cards. Same 1-row client projection as the cards (dashboardRowsForNavSubtree +
 * cardGroupMetricsByPeriodFromAccounts); the % leg is the server-computed flow-adjusted
 * pct on the dashboard row. Balance carries the day P/L line under the value;
 * period columns (Mes/Año/Total) stack aportes and a `P/L (pct%)` line per cell.
 * Parallel desktop `<td>` / mobile `<TableMobileCard>` renderings (keep in sync).
 */
export function PortfolioNavAccountsSummaryTable({
  dash,
  navChildren,
  showUsd,
  animated = true,
  placeholderPhase = false,
}: PortfolioNavAccountsSummaryTableProps) {
  const { t } = useTranslation();

  const rows: AccountTableRow[] = useMemo(() => {
    const filtered = navChildren.filter((c) => c.route_path?.trim());
    const built = filtered.map((child) => {
      const accountRows = dashboardRowsForNavSubtree(dash.accounts, child);
      const { clp, apiUsd } = sumCurrentValueClpUsd(accountRows, showUsd);
      return {
        child,
        label: resolveNavTreeLabel(child),
        routePath: child.route_path?.trim() ?? "",
        clp,
        apiUsd,
        metricsByPeriod: cardGroupMetricsByPeriodFromAccounts(accountRows),
        single: accountRows.length === 1 ? accountRows[0] : null,
        fxMissing: showUsd && accountRows.some((r) => r.fx_missing),
        syncStale: accountRows.length > 0 && accountRows.every((r) => r.sync_stale === true),
      };
    });
    return built.sort((a, b) =>
      compareDashboardCardMainDesc(a.clp, a.apiUsd, b.clp, b.apiUsd, showUsd)
    );
  }, [navChildren, dash.accounts, showUsd]);

  if (!rows.length) return null;

  const labels = {
    account: t("groupPage.accountsTable.account"),
    balance: t("groupPage.accountsTable.balance"),
    month: t("groupPage.accountsTable.month"),
    year: t("groupPage.accountsTable.year"),
    total: t("groupPage.accountsTable.total"),
    pct: t("groupPage.accountsTable.pctTooltip"),
    deposits: {
      month: t("dashboard.cardBreakdown.periodDepositsMonth"),
      year: t("dashboard.cardBreakdown.periodDepositsYear"),
      total: t("dashboard.cardBreakdown.totalDeposited"),
    } as Record<Exclude<PeriodSlice, "day">, string>,
    pl: {
      day: t("dashboard.cardBreakdown.periodDeltaDay"),
      month: t("dashboard.cardBreakdown.periodDeltaMonth"),
      year: t("dashboard.cardBreakdown.periodDeltaYear"),
      total: t("dashboard.cardBreakdown.totalDelta"),
    } as Record<PeriodSlice, string>,
  };

  const header = (
    <thead>
      <tr>
        <th className="desktop-only">{labels.account}</th>
        <th className="desktop-only">{labels.balance}</th>
        <th className="desktop-only">{labels.month}</th>
        <th className="desktop-only">{labels.year}</th>
        <th className="desktop-only">{labels.total}</th>
        <th className="mobile-only" aria-hidden="true" />
      </tr>
    </thead>
  );

  return (
    <Table header={header} tableClassName="table--parallel-mobile table--accounts-summary">
      {rows.map((row) => {
        const { metricsByPeriod, single } = row;
        const lifetime = metricsByPeriod.month;
        const cardSlug = `nav-acc-table-${row.child.slug}-${row.child.node_id}`;
        const deltaFractionDigits = cardDeltaFractionDigits(metricsByPeriod, showUsd);
        const nameCell = row.routePath ? <Link to={row.routePath}>{row.label}</Link> : row.label;
        // The hidden parallel rendering renders its flows static (animated=false, no mount
        // seed): a display:none number-flow measures digit widths as 0, and coupling it to
        // the visible cell's animation collapses zero targets to empty digits.
        const isAnimated = (variant: CellVariant) => variant === "desktop" && animated;
        /** Balance with the day P/L underneath — the card's balance-row framing. */
        const balanceCell = (variant: CellVariant) => (
          <div style={{ display: "flex", flexDirection: "column", gap: "0.15rem" }}>
            {balanceValue(variant)}
            {plLine("day", variant)}
          </div>
        );
        const balanceValue = (variant: CellVariant) => (
          <DashboardCardValue
            clp={row.clp}
            apiUsd={row.apiUsd}
            showUsd={showUsd}
            animated={isAnimated(variant)}
            placeholderPhase={placeholderPhase}
            // Desktop cell aligns left like every other column ("breakdown" is a
            // block-level right-align meant for card sub-balance lists; the mobile
            // card row keeps it — values are right-aligned there).
            variant={variant === "desktop" ? "main" : "breakdown"}
            mountSeedKey={variant === "desktop" ? `${cardSlug}:balance` : undefined}
            fxMissing={row.fxMissing}
            syncStale={row.syncStale}
          />
        );
        /** Aportes with an inflow/outflow arrow (→ net in, 0 included; ← net out). */
        const depositsLine = (slice: Exclude<PeriodSlice, "day">, variant: CellVariant) => {
          const value = roundedMetricDeposits(
            slice === "total" ? lifetime : metricsByPeriod[slice],
            showUsd,
            slice === "total" ? "total" : "period"
          );
          return (
            <span
              title={labels.deposits[slice]}
              style={{ display: "inline-flex", alignItems: "center", gap: "0.25rem" }}
            >
              {value != null ? (
                <span aria-hidden>{value >= 0 ? "\u2192" : "\u2190"}</span>
              ) : null}
              <DepositedMetricFlow
                value={value}
                showUsd={showUsd}
                animated={isAnimated(variant)}
                placeholderPhase={placeholderPhase}
                mountSeedId={
                  variant === "desktop" ? `${cardSlug}:deposited:${slice}` : `${cardSlug}:m`
                }
              />
            </span>
          );
        };
        /** `▲1xx.xxx (2,68%)` — P/L with the flow-adjusted period % as a parenthetical. */
        const plLine = (slice: PeriodSlice, variant: CellVariant) => {
          const pct = rowPct(single, slice, showUsd);
          return (
            <span style={{ display: "inline-flex", alignItems: "baseline", gap: "0.3rem" }}>
              <span title={labels.pl[slice]}>
                <DeltaMetricFlow
                  delta={roundedMetricDelta(
                    slice === "total" ? lifetime : metricsByPeriod[slice],
                    showUsd,
                    slice === "total" ? "total" : "period"
                  )}
                  animated={isAnimated(variant)}
                  placeholderPhase={placeholderPhase}
                  mountSeedId={variant === "desktop" ? `${cardSlug}:delta:${slice}` : undefined}
                  fractionDigits={deltaFractionDigits}
                  className="accounts-summary-delta"
                />
              </span>
              {pct != null ? (
                <span
                  className="mono muted"
                  style={{ fontSize: "var(--font-size-card-meta-sm)" }}
                  title={labels.pct}
                >
                  ({formatPct(pct * 100)})
                </span>
              ) : null}
            </span>
          );
        };
        const periodCell = (slice: PeriodSlice, variant: CellVariant) => (
          <div style={{ display: "flex", flexDirection: "column", gap: "0.15rem" }}>
            {slice !== "day" ? depositsLine(slice, variant) : null}
            {plLine(slice, variant)}
          </div>
        );
        const rowStyle = row.child.chart_inactive ? { opacity: 0.55 } : undefined;
        return (
          <tr key={row.child.node_id} style={rowStyle}>
            <td className="desktop-only">{nameCell}</td>
            <td className="mono desktop-only">{balanceCell("desktop")}</td>
            <td className="mono desktop-only">{periodCell("month", "desktop")}</td>
            <td className="mono desktop-only">{periodCell("year", "desktop")}</td>
            <td className="mono desktop-only">{periodCell("total", "desktop")}</td>
            <td className="mobile-only">
              <TableMobileCard title={nameCell}>
                <TableMobileCardSection>
                  <TableMobileCardRow label={labels.balance} value={balanceCell("mobile")} />
                </TableMobileCardSection>
                <TableMobileCardSection>
                  <TableMobileCardRow label={labels.month} value={periodCell("month", "mobile")} />
                  <TableMobileCardRow label={labels.year} value={periodCell("year", "mobile")} />
                </TableMobileCardSection>
                <TableMobileCardSection>
                  <TableMobileCardRow label={labels.total} value={periodCell("total", "mobile")} />
                </TableMobileCardSection>
              </TableMobileCard>
            </td>
          </tr>
        );
      })}
    </Table>
  );
}
