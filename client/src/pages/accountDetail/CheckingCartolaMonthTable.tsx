import { useTranslation } from "../../i18n";
import { formatClp } from "../../format";
import type { CheckingCartolaMonthRowDto } from "../../types";
import { Table } from "../../components/ui/Table";
import { formatYmEs } from "./shared";

function fmtMoney(n: number, hasCartola: boolean): string {
  if (!hasCartola && n === 0) return "—";
  return formatClp(n);
}

/** Ledger month-end balance minus parsed cartola saldo final (reference). */
function cartolaBalanceDiff(row: CheckingCartolaMonthRowDto): number | null {
  if (row.balance_end_clp == null || row.cartola_saldo_final_clp == null) return null;
  return row.balance_end_clp - row.cartola_saldo_final_clp;
}

export function CheckingCartolaMonthTable({
  rows,
  importedMonthCount,
  collapsedVisibleRows = 12,
}: {
  rows: readonly CheckingCartolaMonthRowDto[];
  importedMonthCount: number;
  collapsedVisibleRows?: number;
}) {
  const { t } = useTranslation();
  const hidden = Math.max(0, rows.length - collapsedVisibleRows);

  if (rows.length === 0) {
    return <p className="muted">{t("accountDetail.checking.cartolaMonthEmpty")}</p>;
  }

  return (
    <>
      <p className="muted" style={{ fontSize: "var(--font-size-ui)", marginBottom: "0.5rem" }}>
        {t("accountDetail.checking.cartolaMonthImportedCount", {
          imported: importedMonthCount,
          total: rows.length,
        })}
      </p>
      <Table
        collapsedVisibleRows={collapsedVisibleRows}
        showMoreLabel={t("table.showMoreMonths", { count: hidden })}
        showLessLabel={t("table.showLessMonths")}
        header={
          <thead>
            <tr>
              <th>{t("accountDetail.monthCloseColumn")}</th>
              <th>{t("accountDetail.checking.colDeposits")}</th>
              <th>{t("accountDetail.checking.colWithdrawals")}</th>
              <th>{t("accountDetail.checking.colBalanceEnd")}</th>
              <th>{t("accountDetail.checking.colCartolaSaldo")}</th>
              <th>{t("accountDetail.checking.colDiff")}</th>
              <th>{t("accountDetail.checking.colCartola")}</th>
            </tr>
          </thead>
        }
      >
        {rows.map((row) => {
          const diff = cartolaBalanceDiff(row);
          return (
          <tr key={row.period_month}>
            <td className="mono">
              {row.as_of_date} ({formatYmEs(row.period_month)})
            </td>
            <td className="mono">{fmtMoney(row.deposits_clp, row.has_cartola)}</td>
            <td className="mono">{fmtMoney(row.withdrawals_clp, row.has_cartola)}</td>
            <td className="mono">
              {row.balance_end_clp != null ? formatClp(row.balance_end_clp) : "—"}
            </td>
            <td className="mono muted">
              {row.cartola_saldo_final_clp != null
                ? formatClp(row.cartola_saldo_final_clp)
                : "—"}
            </td>
            <td className="mono">{diff != null ? formatClp(diff) : "—"}</td>
            <td className="mono" title={row.source_file || undefined}>
              {row.has_cartola
                ? t("accountDetail.checking.cartolaYes")
                : t("accountDetail.checking.cartolaNo")}
            </td>
          </tr>
          );
        })}
      </Table>
    </>
  );
}
