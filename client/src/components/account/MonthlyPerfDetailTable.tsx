import { useMemo } from "react";
import { useTranslation } from "../../i18n";
import { formatClp, formatInstrumentUnits, formatPct, formatUfBalance, formatUsdFine } from "../../format";
import type { AccountMonthlyPerformanceRow, ConsolidatedMonthlyPerfRow } from "../../types";
import { useDisplayPreferences } from "../../context/DisplayPreferencesContext";
import { PaginatedTable, useClientPagination } from "../ui/PaginatedTable";
import { Table } from "../ui/Table";
import {
  TableMobileCard,
  TableMobileCardRow,
  TableMobileCardSection,
} from "../ui/TableMobileCard";
import { formatYmEs } from "../../pages/accountDetail/shared";

const PAGE_SIZE = 12;

/** Shared with server-paginated callers so `page_size` matches the client-paginated tables. */
export const MONTHLY_PERF_DETAIL_PAGE_SIZE = PAGE_SIZE;

export type MonthlyPerfServerPagination = {
  page: number;
  total: number;
  onPageChange: (page: number) => void;
  /** Dim while a page request is in flight (keepPreviousData). */
  loading?: boolean;
};

function cellPct(p: number | null | undefined) {
  if (p == null || !Number.isFinite(p)) return "—";
  return formatPct(p * 100);
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

function formatPerfPeriodLabel(asOfDate: string, isYearly: boolean): string {
  if (isYearly) return asOfDate.slice(0, 4);
  const ym = asOfDate.slice(0, 7);
  return formatYmEs(ym);
}

function decadeStartYear(y: number): number {
  // Decade: 2020–2029, 2010–2019, etc. (resets on years ending in 0)
  return y - (y % 10);
}

function rollupMonthlyPerfRowsYearly(rows: readonly PerfRow[]): PerfRow[] {
  if (!rows.length) return [];

  const byYear = new Map<string, PerfRow[]>();
  for (const row of rows) {
    const year = row.as_of_date.slice(0, 4);
    if (!byYear.has(year)) byYear.set(year, []);
    byYear.get(year)!.push(row);
  }

  // Build annual rows ascending, then compute DTD as running sum within each decade
  const yearsAsc = [...byYear.keys()].sort((a, b) => a.localeCompare(b));

  let dtdSum = 0;
  let currentDecadeStart = -1;

  const ascRows: PerfRow[] = yearsAsc.map((year) => {
    const monthRows = byYear.get(year)!;
    // Sort months ascending for compound return (rows arrive desc from caller)
    const monthsAsc = [...monthRows].sort((a, b) => a.as_of_date.localeCompare(b.as_of_date));
    const latest = monthRows[0]; // desc-sorted → first is latest

    const netCapitalFlow = monthRows.reduce((s, r) => s + (r.net_capital_flow ?? 0), 0);
    const stockUnitsInflow = monthRows.reduce((s, r) => s + (r.stock_units_inflow ?? 0), 0);
    const nominalPl = monthRows.reduce((s, r) => s + (r.nominal_pl ?? 0), 0);

    // Compound monthly returns: Π(1 + pct_month) - 1
    const pctYear = monthsAsc.reduce((prod, r) => {
      const p = r.pct_month;
      return prod * (1 + (p != null && Number.isFinite(p) ? p : 0));
    }, 1) - 1;

    // DTD: running sum within decade, reset at decade boundary
    const y = Number(year);
    const ds = decadeStartYear(y);
    if (ds !== currentDecadeStart) {
      dtdSum = 0;
      currentDecadeStart = ds;
    }
    dtdSum += nominalPl;

    const mortgageLast = latest as AccountMonthlyPerformanceRow;

    return {
      ...latest,
      as_of_date: `${year}-12-31`,
      net_capital_flow: netCapitalFlow,
      stock_units_inflow: stockUnitsInflow,
      nominal_pl: nominalPl,
      pct_month: pctYear,
      ytd_nominal_pl: dtdSum,
      cumulative_nominal_pl: latest.cumulative_nominal_pl,
      closing_value: latest.closing_value,
      closing_balance_uf: mortgageLast.closing_balance_uf,
      uf_clp_day: mortgageLast.uf_clp_day,
    } as PerfRow;
  });

  // Return newest-first for the table
  return ascRows.reverse();
}

function MonthlyPerfDetailMobileCard({
  row,
  fmtPerf,
  isMortgageAccount,
  isAfpAccount,
  showStockInflowsColumn,
  movementUnitsKind,
  isYearly,
  labels,
}: {
  row: PerfRow;
  fmtPerf: FmtPerf;
  isMortgageAccount: boolean;
  isAfpAccount: boolean;
  showStockInflowsColumn: boolean;
  movementUnitsKind?: (slug: string) => "shares" | "coin";
  isYearly: boolean;
  labels: {
    closing: string;
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
    <TableMobileCard title={formatPerfPeriodLabel(row.as_of_date, isYearly)}>
      <TableMobileCardSection>
        <TableMobileCardRow label={labels.closing} value={fmtPerf(row.closing_value)} />
        {isMortgageAccount ? (
          <TableMobileCardRow
            label={labels.balanceUf}
            value={
              mortgageRow?.closing_balance_uf != null && Number.isFinite(mortgageRow.closing_balance_uf)
                ? formatUfBalance(mortgageRow.closing_balance_uf)
                : "—"
            }
          />
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
        {!isMortgageAccount ? (
          <TableMobileCardRow label={labels.pct} value={cellPct(row.pct_month)} />
        ) : null}
        <TableMobileCardRow label={labels.ytd} value={fmtPerf(row.ytd_nominal_pl)} />
        <TableMobileCardRow label={labels.cum} value={fmtPerf(row.cumulative_nominal_pl)} />
      </TableMobileCardSection>
    </TableMobileCard>
  );
}

export function MonthlyPerfDetailTable({
  rows,
  displayUnit,
  isMortgageAccount = false,
  isAfpAccount = false,
  movementUnitsKind,
  showStockInflowsColumn = true,
  serverPagination,
}: {
  rows: readonly PerfRow[];
  displayUnit: "clp" | "usd";
  isMortgageAccount?: boolean;
  isAfpAccount?: boolean;
  movementUnitsKind?: (slug: string) => "shares" | "coin";
  /** Off for consolidated group tables (mixed instruments). */
  showStockInflowsColumn?: boolean;
  /**
   * When set, `rows` are one server page in final shape (yearly rollup included when
   * metricsPeriod is "year") and pagination state is controlled by the caller.
   */
  serverPagination?: MonthlyPerfServerPagination;
}) {
  const { t } = useTranslation();
  const { metricsPeriod } = useDisplayPreferences();
  const isYearly = metricsPeriod === "year";

  const fmtPerf: FmtPerf = (n) => {
    if (n == null || !Number.isFinite(n)) return "—";
    return displayUnit === "usd" ? formatUsdFine(n) : formatClp(n);
  };

  // Mortgage view: no stock units by definition, and the %/UF-día columns were dropped
  // as redundant sheet helpers — only Saldo UF stays mortgage-specific.
  const showStockInflows = showStockInflowsColumn && !isMortgageAccount;

  const plLabel = isMortgageAccount ? t("accountDetail.perf.plMortgage") : t("accountDetail.perf.plInvestment");
  const pctLabel = isYearly
    ? t("accountDetail.perf.pctInvestmentYearly")
    : t("accountDetail.perf.pctInvestmentMonthly");
  const ytdLabel = isMortgageAccount
    ? (isYearly ? t("accountDetail.perf.ytdMortgageYearly") : t("accountDetail.perf.ytdMortgageMonthly"))
    : (isYearly ? t("accountDetail.perf.ytdInvestmentYearly") : t("accountDetail.perf.ytdInvestmentMonthly"));
  const cumLabel = isMortgageAccount ? t("accountDetail.perf.cumMortgage") : t("accountDetail.perf.cumInvestment");
  const inflowLabel = isAfpAccount ? t("accountDetail.perf.inflowAfp") : t("accountDetail.perf.inflowDefault");

  const mobileLabels = {
    closing: t("accountDetail.closingColumn"),
    balanceUf: t("accountDetail.balanceUfColumn"),
    netDeposits: t("accountDetail.netDepositsColumn"),
    inflow: inflowLabel,
    pl: plLabel,
    pct: pctLabel,
    ytd: ytdLabel,
    cum: cumLabel,
  };

  const sortedRows = useMemo(
    () => [...rows].sort((a, b) => b.as_of_date.localeCompare(a.as_of_date)),
    [rows]
  );

  const displayRows = useMemo(
    () => (isYearly && !serverPagination ? rollupMonthlyPerfRowsYearly(sortedRows) : sortedRows),
    [sortedRows, isYearly, serverPagination]
  );

  const clientPagination = useClientPagination(displayRows, PAGE_SIZE);
  const page = serverPagination?.page ?? clientPagination.page;
  const total = serverPagination?.total ?? clientPagination.total;
  const pageRows = serverPagination ? displayRows : clientPagination.pageRows;
  const setPage = serverPagination?.onPageChange ?? clientPagination.setPage;

  const periodColumnLabel = isYearly
    ? t("accountDetail.yearColumn")
    : t("accountDetail.monthCloseColumn");

  const header = (
    <thead>
      <tr>
        <th className="desktop-only">{periodColumnLabel}</th>
        <th className="desktop-only">{t("accountDetail.closingColumn")}</th>
        {isMortgageAccount ? (
          <th className="desktop-only" style={{ whiteSpace: "nowrap" }}>
            {t("accountDetail.balanceUfColumn")}
          </th>
        ) : null}
        <th className="desktop-only">{t("accountDetail.netDepositsColumn")}</th>
        {showStockInflows ? (
          <th className="desktop-only">{inflowLabel}</th>
        ) : null}
        <th className="desktop-only">{plLabel}</th>
        {!isMortgageAccount ? <th className="desktop-only">{pctLabel}</th> : null}
        <th className="desktop-only">{ytdLabel}</th>
        <th className="desktop-only">{cumLabel}</th>
        <th className="mobile-only" aria-hidden="true" />
      </tr>
    </thead>
  );

  return (
    <PaginatedTable
      page={page}
      pageSize={PAGE_SIZE}
      total={total}
      onPageChange={setPage}
      loading={serverPagination?.loading ?? false}
    >
      <Table
        key={`monthly-detail-page-${page}-${metricsPeriod}`}
        header={header}
        tableClassName="table--parallel-mobile"
      >
        {pageRows.map((row) => {
          const mortgageRow =
            isMortgageAccount && "closing_balance_uf" in row ? (row as AccountMonthlyPerformanceRow) : null;
          return (
            <tr key={row.as_of_date}>
              <td className="mono desktop-only">{formatPerfPeriodLabel(row.as_of_date, isYearly)}</td>
              <td className="mono desktop-only">{fmtPerf(row.closing_value)}</td>
              {isMortgageAccount ? (
                <td className="mono desktop-only" style={{ whiteSpace: "nowrap" }}>
                  {mortgageRow?.closing_balance_uf != null && Number.isFinite(mortgageRow.closing_balance_uf)
                    ? formatUfBalance(mortgageRow.closing_balance_uf)
                    : "—"}
                </td>
              ) : null}
              <td className="mono desktop-only">{fmtPerf(row.net_capital_flow)}</td>
              {showStockInflows ? (
                <td className="mono desktop-only">
                  {formatStockInflow(row, isAfpAccount, movementUnitsKind)}
                </td>
              ) : null}
              <td className="mono desktop-only">{fmtPerf(row.nominal_pl)}</td>
              {!isMortgageAccount ? (
                <td className="mono desktop-only">{cellPct(row.pct_month)}</td>
              ) : null}
              <td className="mono desktop-only">{fmtPerf(row.ytd_nominal_pl)}</td>
              <td className="mono desktop-only">{fmtPerf(row.cumulative_nominal_pl)}</td>
              <td className="mobile-only">
                <MonthlyPerfDetailMobileCard
                  row={row}
                  fmtPerf={fmtPerf}
                  isMortgageAccount={isMortgageAccount}
                  isAfpAccount={isAfpAccount}
                  showStockInflowsColumn={showStockInflows}
                  movementUnitsKind={movementUnitsKind}
                  isYearly={isYearly}
                  labels={mobileLabels}
                />
              </td>
            </tr>
          );
        })}
      </Table>
    </PaginatedTable>
  );
}
