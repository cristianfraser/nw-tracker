import { useMemo } from "react";
import { useTranslation } from "../../i18n";
import { formatClp, formatInstrumentUnits, formatUfBalance, formatUsdFine } from "../../format";
import type { ConsolidatedMonthlyPerfRow } from "../../groupPageConsolidatedTables";
import type { AccountMonthlyPerformanceRow } from "../../types";
import { PaginatedTable } from "../ui/PaginatedTable";

function cellPct(p: number | null | undefined) {
  if (p == null || !Number.isFinite(p)) return "—";
  const s = (p * 100).toFixed(2).replace(".", ",");
  return `${s}%`;
}

type PerfRow = AccountMonthlyPerformanceRow | ConsolidatedMonthlyPerfRow;

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
  const fmtPerf = (n: number | null | undefined) => {
    if (n == null || !Number.isFinite(n)) return "—";
    return displayUnit === "usd" ? formatUsdFine(n) : formatClp(n);
  };

  const plLabel = isMortgageAccount ? "Coste fin. mes" : "P/L mes";
  const pctLabel = isMortgageAccount ? "% s/ saldo ant." : "% mes";
  const ytdLabel = isMortgageAccount ? "Coste fin. YTD" : "P/L YTD";
  const cumLabel = isMortgageAccount ? "Coste fin. acum." : "P/L acum.";
  const inflowLabel = isAfpAccount ? "Cuotas (aportes)" : "Stock inflows";

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
      header={
        <thead>
          <tr>
            <th>{t("accountDetail.monthCloseColumn")}</th>
            <th>{t("accountDetail.closingColumn")}</th>
            {isMortgageAccount ? (
              <>
                <th style={{ whiteSpace: "nowrap" }}>{t("accountDetail.ufDayColumn")}</th>
                <th style={{ whiteSpace: "nowrap" }}>{t("accountDetail.balanceUfColumn")}</th>
              </>
            ) : null}
            <th>{t("accountDetail.netDepositsColumn")}</th>
            {showStockInflowsColumn ? <th>{inflowLabel}</th> : null}
            <th>{plLabel}</th>
            <th>{pctLabel}</th>
            <th>{ytdLabel}</th>
            <th>{cumLabel}</th>
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
              <td className="mono">{row.as_of_date}</td>
              <td className="mono">{fmtPerf(row.closing_value)}</td>
              {isMortgageAccount ? (
                <>
                  <td className="mono" style={{ whiteSpace: "nowrap" }}>
                    {mortgageRow?.uf_clp_day != null && Number.isFinite(mortgageRow.uf_clp_day)
                      ? formatClp(Math.round(mortgageRow.uf_clp_day))
                      : "—"}
                  </td>
                  <td className="mono" style={{ whiteSpace: "nowrap" }}>
                    {mortgageRow?.closing_balance_uf != null && Number.isFinite(mortgageRow.closing_balance_uf)
                      ? formatUfBalance(mortgageRow.closing_balance_uf)
                      : "—"}
                  </td>
                </>
              ) : null}
              <td className="mono">{fmtPerf(row.net_capital_flow)}</td>
              {showStockInflowsColumn ? (
                <td className="mono">
                  {(() => {
                    const u = row.stock_units_inflow ?? 0;
                    if (!Number.isFinite(u) || u === 0) return "—";
                    if (isAfpAccount) return formatInstrumentUnits(u, "shares");
                    const kind = movementUnitsKind?.("") ?? "shares";
                    return formatInstrumentUnits(u, kind);
                  })()}
                </td>
              ) : null}
              <td className="mono">{fmtPerf(row.nominal_pl)}</td>
              <td className="mono">{cellPct(row.pct_month)}</td>
              <td className="mono">{fmtPerf(row.ytd_nominal_pl)}</td>
              <td className="mono">{fmtPerf(row.cumulative_nominal_pl)}</td>
            </tr>
          );
        })
      }
    />
  );
}
