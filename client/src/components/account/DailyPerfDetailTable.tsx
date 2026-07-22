import { useMemo } from "react";
import { useTranslation } from "../../i18n";
import { formatClp, formatPct, formatUsdFine } from "../../format";
import type { DailySeriesPointDto, DailySeriesResponse } from "../../types";
import { PaginatedTable, useClientPagination } from "../ui/PaginatedTable";
import { Table } from "../ui/Table";
import {
  TableMobileCard,
  TableMobileCardRow,
  TableMobileCardSection,
} from "../ui/TableMobileCard";

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
 * Parallel desktop `<td>` / mobile `<TableMobileCard>` renderings (keep in sync).
 */
export function DailyPerfDetailTable({
  series,
  displayUnit,
  dimClosedDays = false,
}: {
  series: DailySeriesResponse | null | undefined;
  displayUnit: "clp" | "usd";
  dimClosedDays?: boolean;
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

  if (!rowsDesc.length) {
    return <p className="muted">{t("groupPage.dailyDetailEmpty")}</p>;
  }

  const header = (
    <thead>
      <tr>
        <th className="desktop-only">{labels.date}</th>
        <th className="desktop-only">{labels.closing}</th>
        <th className="desktop-only">{labels.netDeposits}</th>
        <th className="desktop-only">{labels.pl}</th>
        <th className="desktop-only">{labels.pct}</th>
        <th className="mobile-only" aria-hidden="true" />
      </tr>
    </thead>
  );

  return (
    <PaginatedTable page={page} pageSize={PAGE_SIZE} total={total} onPageChange={setPage}>
      <Table
        key={`daily-detail-page-${page}`}
        header={header}
        tableClassName="table--parallel-mobile"
      >
        {pageRows.map((row) => (
          <tr
            key={row.as_of_date}
            style={dimClosedDays && row.market_day === false ? { opacity: 0.45 } : undefined}
          >
            <td className="mono desktop-only">{row.as_of_date}</td>
            <td className="mono desktop-only">{fmt(row.value)}</td>
            <td className="mono desktop-only">{row.flow !== 0 ? fmt(row.flow) : "—"}</td>
            <td className="mono desktop-only">{fmt(row.pl)}</td>
            <td className="mono desktop-only">{cellPct(row.pct)}</td>
            <td className="mobile-only">
              <TableMobileCard title={row.as_of_date}>
                <TableMobileCardSection>
                  <TableMobileCardRow label={labels.closing} value={fmt(row.value)} />
                  <TableMobileCardRow
                    label={labels.netDeposits}
                    value={row.flow !== 0 ? fmt(row.flow) : "—"}
                  />
                </TableMobileCardSection>
                <TableMobileCardSection>
                  <TableMobileCardRow label={labels.pl} value={fmt(row.pl)} />
                  <TableMobileCardRow label={labels.pct} value={cellPct(row.pct)} />
                </TableMobileCardSection>
              </TableMobileCard>
            </td>
          </tr>
        ))}
      </Table>
    </PaginatedTable>
  );
}
