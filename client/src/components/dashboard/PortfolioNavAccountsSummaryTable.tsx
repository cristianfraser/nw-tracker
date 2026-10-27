import { useState, type ReactNode } from "react";
import { Button } from "@crfrsr/ui";
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
import {
  dashboardRowsForNavSubtree,
  portfolioNavParentMainValue,
  portfolioNavParentTitleModeForNavNode,
  requireNavCardMetrics,
} from "../../portfolioNavDashboardCards";
import { resolveNavTreeLabel } from "../../sidebarNavFromApi";
import type {
  DashboardAccountRow,
  DashboardResponse,
  NavCardMetricsDto,
  NavTreeNodeDto,
} from "../../types";
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
  dash: Pick<DashboardResponse, "accounts" | "card_metrics_by_slug" | "totals">;
  /** The page the table belongs to: its «Total» row and its liquidated rows' metrics. */
  pageNode: NavTreeNodeDto;
  navChildren: NavTreeNodeDto[];
  /** Liquidated rows (server `liquidated`); two or more are grouped as one row. */
  liquidatedChildren?: NavTreeNodeDto[];
  /** First row = the page's own figures (when the table replaces the page's summary card). */
  showTotalRow?: boolean;
  showUsd: boolean;
  animated?: boolean;
};

type PeriodSlice = "day" | "month" | "year" | "total";
type CellVariant = "desktop" | "mobile";
type RowKind = "total" | "row" | "liquidated" | "liquidated_detail";
type PctBySlice = NavCardMetricsDto["row_pct"];

type AccountTableRow = {
  key: string;
  kind: RowKind;
  name: ReactNode;
  clp: number;
  apiUsd: number | null;
  metricsByPeriod: CardGroupMetricsByPeriod;
  /** Per-slice % (server: the account row's pct fields, or a group's server pct). */
  pct: (slice: PeriodSlice, showUsd: boolean) => number | null;
  fxMissing: boolean;
  syncStale: boolean;
  inactive: boolean;
};

function accountRowPct(
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

function serverPct(pct: PctBySlice) {
  return (slice: PeriodSlice, usd: boolean): number | null => {
    const v = pct[slice][usd ? "usd" : "clp"];
    return v != null && Number.isFinite(v) ? v : null;
  };
}

const LIQUIDATED_OPEN_LS_PREFIX = "nw-tracker.surface.";

function readLiquidatedOpen(pageSlug: string): boolean {
  try {
    return localStorage.getItem(`${LIQUIDATED_OPEN_LS_PREFIX}${pageSlug}.liquidated`) === "open";
  } catch {
    return false;
  }
}

function writeLiquidatedOpen(pageSlug: string, open: boolean): void {
  try {
    const key = `${LIQUIDATED_OPEN_LS_PREFIX}${pageSlug}.liquidated`;
    if (open) localStorage.setItem(key, "open");
    else localStorage.removeItem(key);
  } catch {
    // Per-viewer convenience only: unavailable storage just forgets the choice.
  }
}

/**
 * Leaf-bucket account summary: one row per account leaf, replacing the old per-account
 * compact cards. Same 1-row client projection as the cards (dashboardRowsForNavSubtree +
 * cardGroupMetricsByPeriodFromAccounts); the % leg is the server-computed flow-adjusted
 * pct on the dashboard row. A bucket listed beside the accounts (IPSA among Acciones'
 * stocks) is one row too, with the server's card metrics and `row_pct`. Balance carries the
 * day P/L line under the value; period columns (Mes/Año/Total) stack aportes and a
 * `P/L (pct%)` line per cell.
 *
 * Optional first «Total» row (the page's `parent` metrics and `parent_pct`, when the table
 * stands in for the page's summary card), and two or more liquidated rows folded into one
 * «Liquidadas (n)» row with the server's `liquidated` metrics, opened with «Ver más».
 * Parallel desktop `<td>` / mobile `<TableMobileCard>` renderings (keep in sync).
 */
export function PortfolioNavAccountsSummaryTable({
  dash,
  pageNode,
  navChildren,
  liquidatedChildren = [],
  showTotalRow = false,
  showUsd,
  animated = true,
}: PortfolioNavAccountsSummaryTableProps) {
  const { t } = useTranslation();
  const [liquidatedOpen, setLiquidatedOpen] = useState(() => readLiquidatedOpen(pageNode.slug));
  const toggleLiquidated = () => {
    setLiquidatedOpen((open) => {
      writeLiquidatedOpen(pageNode.slug, !open);
      return !open;
    });
  };

  const childRow = (child: NavTreeNodeDto, kind: RowKind): AccountTableRow => {
    const accountRows = dashboardRowsForNavSubtree(dash.accounts, child);
    const { clp, apiUsd } = sumCurrentValueClpUsd(accountRows, showUsd);
    const isGroup = child.account_id == null;
    const serverMetrics = isGroup ? requireNavCardMetrics(dash, child) : null;
    const single = accountRows.length === 1 ? accountRows[0]! : null;
    const label = resolveNavTreeLabel(child);
    const routePath = child.route_path?.trim() ?? "";
    return {
      key: child.node_id,
      kind,
      name: routePath ? <Link to={routePath}>{label}</Link> : label,
      clp,
      apiUsd,
      metricsByPeriod: serverMetrics
        ? serverMetrics.child
        : cardGroupMetricsByPeriodFromAccounts(accountRows),
      pct: serverMetrics
        ? serverPct(serverMetrics.row_pct)
        : (slice, usd) => accountRowPct(single, slice, usd),
      fxMissing: showUsd && accountRows.some((r) => r.fx_missing),
      syncStale: accountRows.length > 0 && accountRows.every((r) => r.sync_stale === true),
      inactive: child.chart_inactive === true,
    };
  };

  const rows: AccountTableRow[] = (() => {
    const sortDesc = (list: AccountTableRow[]) =>
      list.sort((a, b) => compareDashboardCardMainDesc(a.clp, a.apiUsd, b.clp, b.apiUsd, showUsd));
    const grouped = liquidatedChildren.length >= 2;
    const main = sortDesc(
      [...navChildren, ...(grouped ? [] : liquidatedChildren)]
        .filter((c) => c.route_path?.trim())
        .map((c) => childRow(c, "row"))
    );
    const out: AccountTableRow[] = [];

    if (showTotalRow) {
      const metrics = requireNavCardMetrics(dash, pageNode);
      const subtreeRows = dashboardRowsForNavSubtree(dash.accounts, pageNode);
      const { clp, apiUsd } = portfolioNavParentMainValue(
        dash,
        portfolioNavParentTitleModeForNavNode(pageNode),
        subtreeRows,
        showUsd
      );
      out.push({
        key: `total.${pageNode.node_id}`,
        kind: "total",
        name: t("groupPage.accountsTable.totalRow"),
        clp,
        apiUsd,
        metricsByPeriod: metrics.parent,
        pct: serverPct(metrics.parent_pct),
        fxMissing: showUsd && subtreeRows.some((r) => r.fx_missing),
        syncStale: subtreeRows.length > 0 && subtreeRows.every((r) => r.sync_stale === true),
        inactive: false,
      });
    }
    out.push(...main);

    if (grouped) {
      const liquidated = requireNavCardMetrics(dash, pageNode).liquidated;
      if (!liquidated) {
        throw new Error(`card_metrics_by_slug.${pageNode.slug} has liquidated rows but no metrics`);
      }
      const ids = new Set<number>();
      for (const c of liquidatedChildren) {
        for (const r of dashboardRowsForNavSubtree(dash.accounts, c)) ids.add(r.account_id);
      }
      const liquidatedRows = dash.accounts.filter((r) => ids.has(r.account_id));
      const { clp, apiUsd } = sumCurrentValueClpUsd(liquidatedRows, showUsd);
      out.push({
        key: `liquidated.${pageNode.node_id}`,
        kind: "liquidated",
        name: t("groupPage.accountsTable.liquidated", { count: liquidatedChildren.length }),
        clp,
        apiUsd,
        metricsByPeriod: liquidated.metrics,
        pct: serverPct(liquidated.row_pct),
        fxMissing: showUsd && liquidatedRows.some((r) => r.fx_missing),
        syncStale: false,
        inactive: true,
      });
      if (liquidatedOpen) {
        out.push(...sortDesc(liquidatedChildren.map((c) => childRow(c, "liquidated_detail"))));
      }
    }
    return out;
  })();

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

  const liquidatedToggle = (
    <Button
      variant="link"
      size="sm"
      onClick={toggleLiquidated}
      aria-expanded={liquidatedOpen}
      className="accounts-summary-liquidated-toggle"
    >
      {liquidatedOpen ? "\u25BE " : "\u25B8 "}
      {liquidatedOpen
        ? t("groupPage.accountsTable.hideLiquidated")
        : t("groupPage.accountsTable.showLiquidated")}
    </Button>
  );

  return (
    <Table header={header} tableClassName="table--parallel-mobile table--accounts-summary">
      {rows.map((row) => {
        const { metricsByPeriod } = row;
        const lifetime = metricsByPeriod.month;
        const deltaFractionDigits = cardDeltaFractionDigits(metricsByPeriod, showUsd);
        const nameCell =
          row.kind === "liquidated" ? (
            <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-start" }}>
              <span>{row.name}</span>
              {liquidatedToggle}
            </div>
          ) : (
            row.name
          );
        // The hidden parallel rendering renders its flows static (animated=false): a
        // display:none number-flow measures digit widths as 0, and coupling it to the
        // visible cell's animation collapses zero targets to empty digits.
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
            // Desktop cell aligns left like every other column ("breakdown" is a
            // block-level right-align meant for card sub-balance lists; the mobile
            // card row keeps it — values are right-aligned there).
            variant={variant === "desktop" ? "main" : "breakdown"}
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
              />
            </span>
          );
        };
        /** `▲1xx.xxx (2,68%)` — P/L with the flow-adjusted period % as a parenthetical. */
        const plLine = (slice: PeriodSlice, variant: CellVariant) => {
          const pct = row.pct(slice, showUsd);
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
        const rowClass =
          row.kind === "total"
            ? "accounts-summary-row--total"
            : row.kind === "liquidated_detail"
              ? "accounts-summary-row--liquidated-detail"
              : undefined;
        const rowStyle = row.inactive ? { opacity: 0.55 } : undefined;
        return (
          <tr key={row.key} className={rowClass} style={rowStyle}>
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
