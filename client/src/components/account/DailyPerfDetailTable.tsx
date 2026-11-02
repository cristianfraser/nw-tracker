import { useMemo } from "react";
import { useTranslation } from "../../i18n";
import { formatClp, formatPct, formatUsdFine } from "../../format";
import type { DailySeriesPointDto, DailySeriesResponse } from "../../types";
import { PaginatedTable, useClientPagination } from "../ui/PaginatedTable";
import { PerfDetailRows, type PerfDetailColumn } from "./PerfDetailRows";

const PAGE_SIZE = 12;

function cellPct(p: number | null | undefined) {
  if (p == null || !Number.isFinite(p)) return "—";
  return formatPct(p * 100);
}

/**
 * Detalle por día: one row per calendar day from `GET /api/daily-series` (cierre, day deposits,
 * day P/L = Δ − flow, day %). With `dimClosedDays` (account pages only — a single account has
 * one market calendar), rows with `market_day: false` (weekend/shared holiday) render dimmed;
 * bucket pages mix calendars, so their weekend rows carry real crypto/UF P/L and stay normal.
 * Dates render as ISO YYYY-MM-DD per the repo date convention.
 * One rendering at every width (`PerfDetailRows`).
 */
export function DailyPerfDetailTable({
  series,
  displayUnit,
  dimClosedDays = false,
  loading = false,
}: {
  series: DailySeriesResponse | null | undefined;
  displayUnit: "clp" | "usd";
  dimClosedDays?: boolean;
  /** The series is not in yet (or is held prior data): the table dims; with no rows it shows its header only, never the empty copy. */
  loading?: boolean;
}) {
  const { t } = useTranslation();

  const fmt = (n: number | null | undefined): string => {
    if (n == null || !Number.isFinite(n)) return "—";
    return displayUnit === "usd" ? formatUsdFine(n) : formatClp(n);
  };

  const rowsDesc: DailySeriesPointDto[] = useMemo(
    () => [...(series?.points ?? [])].sort((a, b) => b.as_of_date.localeCompare(a.as_of_date)),
    [series?.points]
  );

  const { page, total, pageRows, setPage } = useClientPagination(rowsDesc, PAGE_SIZE);

  const labels = {
    date: t("accountDetail.dayColumn"),
    closing: t("accountDetail.closingColumn"),
    netDeposits: t("accountDetail.netDepositsColumn"),
    pl: t("accountDetail.perf.plDay"),
    pct: t("accountDetail.perf.pctDay"),
  };

  if (!rowsDesc.length && !loading) {
    return <p className="muted">{t("groupPage.dailyDetailEmpty")}</p>;
  }

  const columns: PerfDetailColumn<DailySeriesPointDto>[] = [
    { key: "closing", label: labels.closing, value: (row) => fmt(row.value) },
    { key: "deposits", label: labels.netDeposits, value: (row) => (row.flow !== 0 ? fmt(row.flow) : "—") },
    { key: "pl", label: labels.pl, value: (row) => fmt(row.pl) },
    { key: "pct", label: labels.pct, value: (row) => cellPct(row.pct) },
  ];

  return (
    <PaginatedTable page={page} pageSize={PAGE_SIZE} total={total} onPageChange={setPage} loading={loading}>
      <PerfDetailRows
        rows={pageRows}
        rowKey={(row) => row.as_of_date}
        period={(row) => row.as_of_date}
        periodLabel={labels.date}
        columns={columns}
        dimRow={dimClosedDays ? (row) => row.market_day === false : undefined}
      />
    </PaginatedTable>
  );
}
