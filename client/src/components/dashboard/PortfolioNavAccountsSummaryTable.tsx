import { type ReactNode } from "react";
import { useSurfaceLiquidatedOpen } from "../../surfaceDisplayPrefs";
import { Button } from "@crfrsr/ui";
import { Link } from "react-router-dom";
import { cn } from "../../cn";
import {
  cardMetricsByPeriodForAccountRow,
  compareDashboardCardMainDesc,
  roundedMetricDelta,
  roundedMetricDeposits,
  type CardGroupMetricsByPeriod,
} from "../../dashboardCardBreakdown";
import { formatPct } from "../../format";
import { useTranslation } from "../../i18n";
import { requireNavCardMetrics } from "../../portfolioNavDashboardCards";
import type { DisplayUnit } from "../../queries/keys";
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
import styles from "./PortfolioNavAccountsSummaryTable.module.css";

export type PortfolioNavAccountsSummaryTableProps = {
  dash: Pick<DashboardResponse, "accounts" | "card_metrics_by_slug">;
  /** The page the table belongs to: its «Total» row and its liquidated rows' metrics. */
  pageNode: NavTreeNodeDto;
  navChildren: NavTreeNodeDto[];
  /** Liquidated rows (server `liquidated`); two or more are grouped as one row. */
  liquidatedChildren?: NavTreeNodeDto[];
  /** First row = the page's own figures (when the table replaces the page's summary card). */
  showTotalRow?: boolean;
  /** The payload's unit (every figure of `dash` is in it). */
  unit: DisplayUnit;
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
  /** In the payload's unit. */
  value: number | null;
  metricsByPeriod: CardGroupMetricsByPeriod;
  /** Per-slice % (server: the account row's pct fields, or a group's server pct). */
  pct: (slice: PeriodSlice) => number | null;
  /** The total cell's return on net deposits: P/L acumulado ÷ net deposits (tooltip on the total %). */
  pctOnDeposits: () => number | null;
  fxMissing: boolean;
  syncStale: boolean;
  inactive: boolean;
};

function finiteOrNull(v: number | null | undefined): number | null {
  return v != null && Number.isFinite(v) ? v : null;
}

function accountRowPct(row: DashboardAccountRow | null, slice: PeriodSlice): number | null {
  if (!row) return null;
  return finiteOrNull({ day: row.pct_day, month: row.pct_month, year: row.pct_year, total: row.pct_total }[slice]);
}

function serverPct(pct: PctBySlice) {
  return (slice: PeriodSlice): number | null => finiteOrNull(pct[slice].value);
}

/** The server's total cell carries the on-deposits figure; other cells do not. */
function serverPctOnDeposits(pct: PctBySlice) {
  return (): number | null => finiteOrNull(pct.total.on_deposits);
}

/**
 * Leaf-bucket account summary: one row per account leaf. An account row projects its own dashboard row (value, metrics, server pct);
 * a bucket listed beside the accounts (IPSA among Acciones' stocks) is one row too, with the
 * server's `value.child`, card metrics and `row_pct`. Balance carries the day P/L line under
 * the value; period columns (Mes/Año/Total) stack aportes and a `P/L (pct%)` line per cell.
 *
 * Optional first «Total» row (the page's `value.parent`, `parent` metrics and `parent_pct`,
 * when the table stands in for the page's summary card), and two or more liquidated rows
 * folded into one «Liquidadas (n)» row with the server's `liquidated` figures, opened with
 * «Ver más». No figure here is a client Σ of rows.
 * Parallel desktop `<td>` / mobile `<TableMobileCard>` renderings (keep in sync).
 */
export function PortfolioNavAccountsSummaryTable({
  dash,
  pageNode,
  navChildren,
  liquidatedChildren = [],
  showTotalRow = false,
  unit,
  animated = true,
}: PortfolioNavAccountsSummaryTableProps) {
  const { t } = useTranslation();
  const liquidated = useSurfaceLiquidatedOpen(`${pageNode.slug}.liquidated`);
  const liquidatedOpen = liquidated.open;
  const toggleLiquidated = () => liquidated.setOpen(!liquidatedOpen);

  const childRow = (child: NavTreeNodeDto, kind: RowKind): AccountTableRow => {
    const label = resolveNavTreeLabel(child);
    const routePath = child.route_path?.trim() ?? "";
    const base = {
      key: child.node_id,
      kind,
      name: routePath ? <Link to={routePath}>{label}</Link> : label,
      inactive: child.chart_inactive === true,
    };
    if (child.account_id == null) {
      const entry = requireNavCardMetrics(dash, child);
      return {
        ...base,
        value: entry.value.child,
        metricsByPeriod: entry.child,
        pct: serverPct(entry.row_pct),
        pctOnDeposits: serverPctOnDeposits(entry.row_pct),
        fxMissing: entry.value.fx_missing,
        syncStale: entry.value.sync_stale,
      };
    }
    const accountId = child.account_id;
    const row = dash.accounts.find((r) => r.account_id === accountId) ?? null;
    return {
      ...base,
      // Pesos: a row without a value reads 0 (the ledger unit is always present).
      value: finiteOrNull(row?.current_value) ?? (unit === "clp" ? 0 : null),
      metricsByPeriod: cardMetricsByPeriodForAccountRow(row, unit),
      pct: (slice) => accountRowPct(row, slice),
      pctOnDeposits: () => finiteOrNull(row?.pct_total_on_deposits),
      fxMissing: row?.fx_missing === true,
      syncStale: row?.sync_stale === true,
    };
  };

  const rows: AccountTableRow[] = (() => {
    const sortDesc = (list: AccountTableRow[]) =>
      list.sort((a, b) => compareDashboardCardMainDesc(a.value, b.value));
    const grouped = liquidatedChildren.length >= 2;
    const main = sortDesc(
      [...navChildren, ...(grouped ? [] : liquidatedChildren)]
        .filter((c) => c.route_path?.trim())
        .map((c) => childRow(c, "row"))
    );
    const out: AccountTableRow[] = [];

    if (showTotalRow) {
      const metrics = requireNavCardMetrics(dash, pageNode);
      out.push({
        key: `total.${pageNode.node_id}`,
        kind: "total",
        name: t("groupPage.accountsTable.totalRow"),
        value: metrics.value.parent,
        metricsByPeriod: metrics.parent,
        pct: serverPct(metrics.parent_pct),
        pctOnDeposits: serverPctOnDeposits(metrics.parent_pct),
        fxMissing: metrics.value.fx_missing,
        syncStale: metrics.value.sync_stale,
        inactive: false,
      });
    }
    out.push(...main);

    if (grouped) {
      const liquidated = requireNavCardMetrics(dash, pageNode).liquidated;
      if (!liquidated) {
        throw new Error(`card_metrics_by_slug.${pageNode.slug} has liquidated rows but no metrics`);
      }
      out.push({
        key: `liquidated.${pageNode.node_id}`,
        kind: "liquidated",
        name: t("groupPage.accountsTable.liquidated", { count: liquidatedChildren.length }),
        value: liquidated.value.value,
        metricsByPeriod: liquidated.metrics,
        pct: serverPct(liquidated.row_pct),
        pctOnDeposits: serverPctOnDeposits(liquidated.row_pct),
        fxMissing: liquidated.value.fx_missing,
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
        const deltaFractionDigits = cardDeltaFractionDigits(metricsByPeriod, unit);
        const nameCell =
          row.kind === "liquidated" ? (
            <div className={styles.nameStack}>
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
          <div className={styles.cellStack}>
            {balanceValue(variant)}
            {plLine("day", variant)}
          </div>
        );
        const balanceValue = (variant: CellVariant) => (
          <DashboardCardValue
            value={row.value}
            unit={unit}
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
            slice === "total" ? "total" : "period"
          );
          return (
            <span title={labels.deposits[slice]} className={styles.depositsLine}>
              {value != null ? (
                <span aria-hidden>{value >= 0 ? "\u2192" : "\u2190"}</span>
              ) : null}
              <DepositedMetricFlow
                value={value}
                unit={unit}
                animated={isAnimated(variant)}
              />
            </span>
          );
        };
        /** `▲1xx.xxx (2,68%)` — P/L with the flow-adjusted period % as a parenthetical. */
        const plLine = (slice: PeriodSlice, variant: CellVariant) => {
          const pct = row.pct(slice);
          // The total %: the compounded return; its hover gives the return on net deposits.
          const onDeposits = slice === "total" ? row.pctOnDeposits() : null;
          return (
            <span className={styles.plLine}>
              <span title={labels.pl[slice]}>
                <DeltaMetricFlow
                  delta={roundedMetricDelta(
                    slice === "total" ? lifetime : metricsByPeriod[slice],
                    unit,
                    slice === "total" ? "total" : "period"
                  )}
                  animated={isAnimated(variant)}
                  fractionDigits={deltaFractionDigits}
                  className="accounts-summary-delta"
                />
              </span>
              {pct != null ? (
                <span
                  className={cn("mono muted", styles.pct)}
                  title={
                    onDeposits != null
                      ? t("groupPage.accountsTable.pctOnDeposits", { pct: formatPct(onDeposits * 100) })
                      : labels.pct
                  }
                >
                  ({formatPct(pct * 100)})
                </span>
              ) : null}
            </span>
          );
        };
        const periodCell = (slice: PeriodSlice, variant: CellVariant) => (
          <div className={styles.cellStack}>
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
        return (
          <tr key={row.key} className={cn(rowClass, row.inactive && styles.rowInactive)}>
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
