import { useMemo } from "react";
import { useTranslation } from "../../i18n";
import { formatClp, formatInstrumentUnits, formatUfBalance, formatUsdFine } from "../../format";
import type { AccountMonthlyPerformanceRow, ConsolidatedMonthlyPerfRow } from "../../types";
import { PaginatedTable } from "../ui/PaginatedTable";
import {
  TableMobileCard,
  TableMobileCardRow,
  TableMobileCardSection,
} from "../ui/TableMobileCard";

function cellPct(p: number | null | undefined) {
  if (p == null || !Number.isFinite(p)) return "—";
  const s = (p * 100).toFixed(2).replace(".", ",");
  return `${s}%`;
}

type PerfRow = AccountMonthlyPerformanceRow | ConsolidatedMonthlyPerfRow;

type FmtPerf = (n: number | null | undefined) => string;

function formatStockInflow(
  row: PerfRow,
  isAfpAccount: boolean,
  movementUnitsKind?: (slug: string) => "shares" | "coin"
): string {
  const u = row.stock_units_inflow ?? 0;
  if (!Number.isFinite(u) || u === 0) return "—";
  if (isAfpAccount) return formatInstrumentUnits(u, "shares");
  const kind = movementUnitsKind?.("") ?? "shares";
  return formatInstrumentUnits(u, kind);
}

function MonthlyPerfDetailMobileCard({
  row,
  fmtPerf,
  isMortgageAccount,
  isAfpAccount,
  showStockInflowsColumn,
  movementUnitsKind,
  labels,
}: {
  row: PerfRow;
  fmtPerf: FmtPerf;
  isMortgageAccount: boolean;
  isAfpAccount: boolean;
  showStockInflowsColumn: boolean;
  movementUnitsKind?: (slug: string) => "shares" | "coin";
  labels: {
    closing: string;
    ufDay: string;
    balanceUf: string;
    netDeposits: string;
    inflow: string;
    pl: string;
    pct: string;
    ytd: string;
    cum: string;
  };
}) {
  const mortgageRow =
    isMortgageAccount && "closing_balance_uf" in row ? (row as AccountMonthlyPerformanceRow) : null;

  return (
    <TableMobileCard title={row.as_of_date}>
      <TableMobileCardSection>
        <TableMobileCardRow label={labels.closing} value={fmtPerf(row.closing_value)} />
        {isMortgageAccount ? (
          <>
            <TableMobileCardRow
              label={labels.ufDay}
              value={
                mortgageRow?.uf_clp_day != null && Number.isFinite(mortgageRow.uf_clp_day)
                  ? formatClp(Math.round(mortgageRow.uf_clp_day))
                  : "—"
              }
            />
            <TableMobileCardRow
              label={labels.balanceUf}
              value={
                mortgageRow?.closing_balance_uf != null && Number.isFinite(mortgageRow.closing_balance_uf)
                  ? formatUfBalance(mortgageRow.closing_balance_uf)
                  : "—"
              }
            />
          </>
        ) : null}
      </TableMobileCardSection>

      <TableMobileCardSection>
        <TableMobileCardRow label={labels.netDeposits} value={fmtPerf(row.net_capital_flow)} />
        {showStockInflowsColumn ? (
          <TableMobileCardRow
            label={labels.inflow}
            value={formatStockInflow(row, isAfpAccount, movementUnitsKind)}
          />
        ) : null}
      </TableMobileCardSection>

      <TableMobileCardSection>
        <TableMobileCardRow label={labels.pl} value={fmtPerf(row.nominal_pl)} />
        <TableMobileCardRow label={labels.pct} value={cellPct(row.pct_month)} />
        <TableMobileCardRow label={labels.ytd} value={fmtPerf(row.ytd_nominal_pl)} />
        <TableMobileCardRow label={labels.cum} value={fmtPerf(row.cumulative_nominal_pl)} />
      </TableMobileCardSection>
    </TableMobileCard>
  );
}

export function MonthlyPerfDetailTable({
  rows,
  displayUnit,
  collapsedVisibleRows = 12,
  isMortgageAccount = false,
  isAfpAccount = false,
  movementUnitsKind,
  showStockInflowsColumn = true,
}: {
  rows: readonly PerfRow[];
  displayUnit: "clp" | "usd";
  collapsedVisibleRows?: number;
  isMortgageAccount?: boolean;
  isAfpAccount?: boolean;
  movementUnitsKind?: (slug: string) => "shares" | "coin";
  /** Off for consolidated group tables (mixed instruments). */
  showStockInflowsColumn?: boolean;
}) {
  const { t } = useTranslation();
  const fmtPerf: FmtPerf = (n) => {
    if (n == null || !Number.isFinite(n)) return "—";
    return displayUnit === "usd" ? formatUsdFine(n) : formatClp(n);
  };

  const plLabel = isMortgageAccount ? "Coste fin. mes" : "P/L mes";
  const pctLabel = isMortgageAccount ? "% s/ saldo ant." : "% mes";
  const ytdLabel = isMortgageAccount ? "Coste fin. YTD" : "P/L YTD";
  const cumLabel = isMortgageAccount ? "Coste fin. acum." : "P/L acum.";
  const inflowLabel = isAfpAccount ? "Cuotas (aportes)" : "Stock inflows";

  const mobileLabels = {
    closing: t("accountDetail.closingColumn"),
    ufDay: t("accountDetail.ufDayColumn"),
    balanceUf: t("accountDetail.balanceUfColumn"),
    netDeposits: t("accountDetail.netDepositsColumn"),
    inflow: inflowLabel,
    pl: plLabel,
    pct: pctLabel,
    ytd: ytdLabel,
    cum: cumLabel,
  };

  const pages = useMemo(() => {
    const byYear = new Map<string, PerfRow[]>();
    for (const row of rows) {
      const year = String(row.as_of_date ?? "").slice(0, 4);
      const bucket = byYear.get(year) ?? [];
      bucket.push(row);
      byYear.set(year, bucket);
    }

    const yearsAsc = [...byYear.keys()].sort((a, b) => Number(a) - Number(b));
    return yearsAsc.map((year, pageNumber) => ({
      pageNumber,
      data: byYear.get(year) ?? [],
    }));
  }, [rows]);

  return (
    <PaginatedTable
      pages={pages}
      collapsedVisibleRows={collapsedVisibleRows}
      showMoreLabel={(hiddenCount) => t("table.showMoreMonths", { count: hiddenCount })}
      showLessLabel={t("table.showLessMonths")}
      tableClassName="table--parallel-mobile"
      header={
        <thead>
          <tr>
            <th className="desktop-only">{t("accountDetail.monthCloseColumn")}</th>
            <th className="desktop-only">{t("accountDetail.closingColumn")}</th>
            {isMortgageAccount ? (
              <>
                <th className="desktop-only" style={{ whiteSpace: "nowrap" }}>
                  {t("accountDetail.ufDayColumn")}
                </th>
                <th className="desktop-only" style={{ whiteSpace: "nowrap" }}>
                  {t("accountDetail.balanceUfColumn")}
                </th>
              </>
            ) : null}
            <th className="desktop-only">{t("accountDetail.netDepositsColumn")}</th>
            {showStockInflowsColumn ? (
              <th className="desktop-only">{inflowLabel}</th>
            ) : null}
            <th className="desktop-only">{plLabel}</th>
            <th className="desktop-only">{pctLabel}</th>
            <th className="desktop-only">{ytdLabel}</th>
            <th className="desktop-only">{cumLabel}</th>
            <th className="mobile-only" aria-hidden="true" />
          </tr>
        </thead>
      }
      getPageLabel={(page) => page.data[0]?.as_of_date.slice(0, 4) ?? String(page.pageNumber)}
      renderBody={(pageRows) =>
        pageRows.map((row) => {
          const mortgageRow =
            isMortgageAccount && "closing_balance_uf" in row ? (row as AccountMonthlyPerformanceRow) : null;
          return (
            <tr key={row.as_of_date}>
              <td className="mono desktop-only">{row.as_of_date}</td>
              <td className="mono desktop-only">{fmtPerf(row.closing_value)}</td>
              {isMortgageAccount ? (
                <>
                  <td className="mono desktop-only" style={{ whiteSpace: "nowrap" }}>
                    {mortgageRow?.uf_clp_day != null && Number.isFinite(mortgageRow.uf_clp_day)
                      ? formatClp(Math.round(mortgageRow.uf_clp_day))
                      : "—"}
                  </td>
                  <td className="mono desktop-only" style={{ whiteSpace: "nowrap" }}>
                    {mortgageRow?.closing_balance_uf != null && Number.isFinite(mortgageRow.closing_balance_uf)
                      ? formatUfBalance(mortgageRow.closing_balance_uf)
                      : "—"}
                  </td>
                </>
              ) : null}
              <td className="mono desktop-only">{fmtPerf(row.net_capital_flow)}</td>
              {showStockInflowsColumn ? (
                <td className="mono desktop-only">
                  {formatStockInflow(row, isAfpAccount, movementUnitsKind)}
                </td>
              ) : null}
              <td className="mono desktop-only">{fmtPerf(row.nominal_pl)}</td>
              <td className="mono desktop-only">{cellPct(row.pct_month)}</td>
              <td className="mono desktop-only">{fmtPerf(row.ytd_nominal_pl)}</td>
              <td className="mono desktop-only">{fmtPerf(row.cumulative_nominal_pl)}</td>
              <td className="mobile-only">
                <MonthlyPerfDetailMobileCard
                  row={row}
                  fmtPerf={fmtPerf}
                  isMortgageAccount={isMortgageAccount}
                  isAfpAccount={isAfpAccount}
                  showStockInflowsColumn={showStockInflowsColumn}
                  movementUnitsKind={movementUnitsKind}
                  labels={mobileLabels}
                />
              </td>
            </tr>
          );
        })
      }
    />
  );
}
