import { useMemo } from "react";
import { useTranslation } from "../../i18n";
import { formatClp, formatInstrumentUnits, formatPct, formatUfBalance, formatUsdFine } from "../../format";
import type { AccountMonthlyPerformanceRow, ConsolidatedMonthlyPerfRow } from "../../types";
import { PaginatedTable, useClientPagination } from "../ui/PaginatedTable";
import { formatYearMonthLabel } from "../../formatDateLabel";
import { PerfDetailRows, type PerfDetailFlow, type PerfDetailRow } from "./PerfDetailRows";
import { BanknoteIcon } from "../icons/BanknoteIcon";
import { CoinsIcon } from "../icons/CoinsIcon";
import { ShoppingBagIcon } from "../icons/ShoppingBagIcon";

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
  unitsKind: "shares" | "coin" | "contracts" = "shares"
): string {
  const u = row.stock_units_inflow ?? 0;
  if (!Number.isFinite(u) || u === 0) return "—";
  if (isAfpAccount) return formatInstrumentUnits(u, "shares");
  return formatInstrumentUnits(u, unitsKind);
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
  unitsKind,
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
  unitsKind?: "shares" | "coin" | "contracts";
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

  // Mortgage view: no stock units by definition.
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

  const ufBalance = (row: PerfRow): string | undefined => {
    const uf = "closing_balance_uf" in row ? (row as AccountMonthlyPerformanceRow).closing_balance_uf : null;
    return uf != null && Number.isFinite(uf) ? formatUfBalance(uf) : undefined;
  };

  // Net worth's rows carry the period's income and spending (its contribution is their difference).
  const showIncome = pageRows.some((row) => "income" in row && row.income != null);
  const amount = (n: number) => fmtPerf(Math.abs(n));

  const perfRows: PerfDetailRow[] = pageRows.map((row) => {
    const income = "income" in row ? row.income : undefined;
    const expenses = "expenses" in row ? row.expenses : undefined;
    const units = row.stock_units_inflow ?? 0;
    const flows: (PerfDetailFlow | null)[] = [
      ...(showIncome
        ? [
            { key: "expenses", icon: ShoppingBagIcon, amount: fmtPerf(expenses ?? 0), title: t("flows.overview.expenses") },
            { key: "income", icon: BanknoteIcon, amount: fmtPerf(income ?? 0), title: t("flows.overview.income") },
          ]
        : []),
      // Shown every period, $0 included: an empty month is information too.
      {
        key: "contribution",
        icon: CoinsIcon,
        amount: fmtPerf(Number.isFinite(row.net_capital_flow) ? row.net_capital_flow : 0),
        title: t("accountDetail.netDepositsColumn"),
      },
      ...(showStockInflows
        ? [
            Number.isFinite(units) && units !== 0
              ? {
                  key: "units",
                  direction: units > 0 ? ("in" as const) : ("out" as const),
                  amount: formatStockInflow({ ...row, stock_units_inflow: Math.abs(units) }, isAfpAccount, unitsKind),
                  title: inflowLabel,
                }
              : null,
          ]
        : []),
    ];
    const pl = row.nominal_pl;
    const pct = !isMortgageAccount && row.pct_month != null && Number.isFinite(row.pct_month) ? cellPct(row.pct_month) : undefined;
    return {
      key: row.as_of_date,
      period: formatPerfPeriodLabel(row.as_of_date, isYearly),
      closing: fmtPerf(row.closing_value),
      closingNote: (() => {
        const uf = isMortgageAccount ? ufBalance(row) : undefined;
        return uf ? { amount: uf, title: t("accountDetail.balanceUfColumn") } : undefined;
      })(),
      flows,
      result:
        pl == null || !Number.isFinite(pl)
          ? null
          : { sign: pl > 0 ? 1 : pl < 0 ? -1 : 0, amount: amount(pl), pct, title: pct ? `${plLabel} · ${pctLabel}` : plLabel },
      totals: [
        ...(!isYearly
          ? [{ key: "ytd", prefix: t("periodReturns.ytd"), amount: fmtPerf(row.ytd_nominal_pl), title: ytdLabel }]
          : []),
        { key: "cum", prefix: "Σ", amount: fmtPerf(row.cumulative_nominal_pl), title: cumLabel },
      ],
    };
  });

  return (
    <PaginatedTable
      page={page}
      pageSize={PAGE_SIZE}
      total={total}
      onPageChange={setPage}
      loading={loading || (serverPagination?.loading ?? false)}
    >
      <PerfDetailRows rows={perfRows} flowSlots={(showIncome ? 2 : 0) + 1 + (showStockInflows ? 1 : 0)} />
    </PaginatedTable>
  );
}
