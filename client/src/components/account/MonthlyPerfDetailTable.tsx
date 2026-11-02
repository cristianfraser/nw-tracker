import { useMemo } from "react";
import { useTranslation } from "../../i18n";
import { formatClp, formatInstrumentUnits, formatPct, formatUfBalance, formatUsdFine } from "../../format";
import type { AccountMonthlyPerformanceRow, ConsolidatedMonthlyPerfRow } from "../../types";
import { PaginatedTable, useClientPagination } from "../ui/PaginatedTable";
import { formatYearMonthLabel } from "../../formatDateLabel";
import { PerfDetailRows, type PerfDetailColumn } from "./PerfDetailRows";

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
  return formatYearMonthLabel(ym);
}

export function MonthlyPerfDetailTable({
  rows,
  yearlyRows,
  displayUnit,
  isMortgageAccount = false,
  isAfpAccount = false,
  movementUnitsKind,
  showStockInflowsColumn = true,
  serverPagination,
  period,
  loading = false,
}: {
  rows: readonly PerfRow[];
  /**
   * The server's «Detalle por año» rows for the same scope (`rollupMonthlyPerfYearly`), shown
   * when `period` is "year". Required unless `serverPagination` is set — then `rows` already is
   * the server's page of the chosen period.
   */
  yearlyRows?: readonly PerfRow[];
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
  /** Per-surface table período (from the table's own control). */
  period: "month" | "year";
  /** The rows are a placeholder or held prior data: the table dims (callers pass the placeholder rows). */
  loading?: boolean;
}) {
  const { t } = useTranslation();
  const isYearly = period === "year";

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
    ? t("accountDetail.perf.ytdMortgageMonthly")
    : t("accountDetail.perf.ytdInvestmentMonthly");
  const cumLabel = isMortgageAccount ? t("accountDetail.perf.cumMortgage") : t("accountDetail.perf.cumInvestment");
  const inflowLabel = isAfpAccount ? t("accountDetail.perf.inflowAfp") : t("accountDetail.perf.inflowDefault");

  if (isYearly && !serverPagination && !yearlyRows) {
    throw new Error("MonthlyPerfDetailTable: yearly view needs the server's yearlyRows");
  }
  const shownRows = isYearly && !serverPagination ? yearlyRows! : rows;
  const displayRows = useMemo(
    () => [...shownRows].sort((a, b) => b.as_of_date.localeCompare(a.as_of_date)),
    [shownRows]
  );

  const clientPagination = useClientPagination(displayRows, PAGE_SIZE);
  const page = serverPagination?.page ?? clientPagination.page;
  const total = serverPagination?.total ?? clientPagination.total;
  const pageRows = serverPagination ? displayRows : clientPagination.pageRows;
  const setPage = serverPagination?.onPageChange ?? clientPagination.setPage;

  const periodColumnLabel = isYearly
    ? t("accountDetail.yearColumn")
    : t("accountDetail.monthCloseColumn");

  const ufBalance = (row: PerfRow): string => {
    const uf = "closing_balance_uf" in row ? (row as AccountMonthlyPerformanceRow).closing_balance_uf : null;
    return uf != null && Number.isFinite(uf) ? formatUfBalance(uf) : "—";
  };

  const columns: PerfDetailColumn<PerfRow>[] = [
    { key: "closing", label: t("accountDetail.closingColumn"), value: (row) => fmtPerf(row.closing_value) },
    ...(isMortgageAccount
      ? [{ key: "uf", label: t("accountDetail.balanceUfColumn"), value: ufBalance }]
      : []),
    { key: "deposits", label: t("accountDetail.netDepositsColumn"), value: (row) => fmtPerf(row.net_capital_flow) },
    ...(showStockInflows
      ? [
          {
            key: "inflow",
            label: inflowLabel,
            value: (row: PerfRow) => formatStockInflow(row, isAfpAccount, movementUnitsKind),
          },
        ]
      : []),
    { key: "pl", label: plLabel, value: (row) => fmtPerf(row.nominal_pl) },
    ...(!isMortgageAccount ? [{ key: "pct", label: pctLabel, value: (row: PerfRow) => cellPct(row.pct_month) }] : []),
    ...(!isYearly ? [{ key: "ytd", label: ytdLabel, value: (row: PerfRow) => fmtPerf(row.ytd_nominal_pl) }] : []),
    { key: "cum", label: cumLabel, value: (row) => fmtPerf(row.cumulative_nominal_pl) },
  ];

  return (
    <PaginatedTable
      page={page}
      pageSize={PAGE_SIZE}
      total={total}
      onPageChange={setPage}
      loading={loading || (serverPagination?.loading ?? false)}
    >
      <PerfDetailRows
        rows={pageRows}
        rowKey={(row) => row.as_of_date}
        period={(row) => formatPerfPeriodLabel(row.as_of_date, isYearly)}
        periodLabel={periodColumnLabel}
        columns={columns}
      />
    </PaginatedTable>
  );
}
