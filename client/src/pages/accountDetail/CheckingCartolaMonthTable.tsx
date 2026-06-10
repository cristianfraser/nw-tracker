import { useTranslation } from "../../i18n";
import { formatClp } from "../../format";
import type { CheckingCartolaMonthRowDto } from "../../types";
import { Table } from "../../components/ui/Table";
import {
  TableMobileCard,
  TableMobileCardRow,
  TableMobileCardSection,
} from "../../components/ui/TableMobileCard";
import { formatYmEs } from "./shared";

function fmtMoney(n: number, hasCartola: boolean): string {
  if (!hasCartola && n === 0) return "—";
  return formatClp(n);
}

function cartolaMonthHasEmptyImport(row: CheckingCartolaMonthRowDto): boolean {
  return row.has_cartola && row.deposits_clp === 0 && row.withdrawals_clp === 0;
}

/** Ledger month-end balance minus parsed cartola saldo final (reference). */
function cartolaBalanceDiff(row: CheckingCartolaMonthRowDto): number | null {
  if (row.balance_end_clp == null || row.cartola_saldo_final_clp == null) return null;
  return row.balance_end_clp - row.cartola_saldo_final_clp;
}

function CheckingCartolaMonthMobileCard({
  row,
  labels,
  emptyImportTitle,
}: {
  row: CheckingCartolaMonthRowDto;
  labels: {
    deposits: string;
    withdrawals: string;
    movements: string;
    balanceEnd: string;
    cartolaSaldo: string;
    diff: string;
    cartola: string;
    cartolaYes: string;
    cartolaNo: string;
  };
  emptyImportTitle?: string;
}) {
  const diff = cartolaBalanceDiff(row);

  return (
    <TableMobileCard title={`${row.as_of_date} (${formatYmEs(row.period_month)})`}>
      <TableMobileCardSection>
        <TableMobileCardRow label={labels.deposits} value={fmtMoney(row.deposits_clp, row.has_cartola)} />
        <TableMobileCardRow label={labels.withdrawals} value={fmtMoney(row.withdrawals_clp, row.has_cartola)} />
        <TableMobileCardRow
          label={labels.movements}
          value={
            <span title={emptyImportTitle}>
              {row.has_cartola ? row.movement_count : "—"}
            </span>
          }
        />
      </TableMobileCardSection>

      <TableMobileCardSection>
        <TableMobileCardRow
          label={labels.balanceEnd}
          value={row.balance_end_clp != null ? formatClp(row.balance_end_clp) : "—"}
        />
        <TableMobileCardRow
          label={labels.cartolaSaldo}
          value={
            row.cartola_saldo_final_clp != null ? formatClp(row.cartola_saldo_final_clp) : "—"
          }
        />
        <TableMobileCardRow label={labels.diff} value={diff != null ? formatClp(diff) : "—"} />
      </TableMobileCardSection>

      <TableMobileCardSection>
        <TableMobileCardRow
          label={labels.cartola}
          value={
            <span title={row.source_file || undefined}>
              {row.has_cartola ? labels.cartolaYes : labels.cartolaNo}
            </span>
          }
        />
      </TableMobileCardSection>
    </TableMobileCard>
  );
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

  const mobileLabels = {
    deposits: t("accountDetail.checking.colDeposits"),
    withdrawals: t("accountDetail.checking.colWithdrawals"),
    movements: t("accountDetail.checking.colMovements"),
    balanceEnd: t("accountDetail.checking.colBalanceEnd"),
    cartolaSaldo: t("accountDetail.checking.colCartolaSaldo"),
    diff: t("accountDetail.checking.colDiff"),
    cartola: t("accountDetail.checking.colCartola"),
    cartolaYes: t("accountDetail.checking.cartolaYes"),
    cartolaNo: t("accountDetail.checking.cartolaNo"),
  };

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
        tableClassName="table--parallel-mobile"
        header={
          <thead>
            <tr>
              <th className="desktop-only">{t("accountDetail.monthCloseColumn")}</th>
              <th className="desktop-only">{t("accountDetail.checking.colDeposits")}</th>
              <th className="desktop-only">{t("accountDetail.checking.colWithdrawals")}</th>
              <th className="desktop-only">{t("accountDetail.checking.colMovements")}</th>
              <th className="desktop-only">{t("accountDetail.checking.colBalanceEnd")}</th>
              <th className="desktop-only">{t("accountDetail.checking.colCartolaSaldo")}</th>
              <th className="desktop-only">{t("accountDetail.checking.colDiff")}</th>
              <th className="desktop-only">{t("accountDetail.checking.colCartola")}</th>
              <th className="mobile-only" aria-hidden="true" />
            </tr>
          </thead>
        }
      >
        {rows.map((row) => {
          const diff = cartolaBalanceDiff(row);
          const emptyImport = cartolaMonthHasEmptyImport(row);
          return (
            <tr key={row.period_month}>
              <td className="mono desktop-only">
                {row.as_of_date} ({formatYmEs(row.period_month)})
              </td>
              <td className="mono desktop-only">{fmtMoney(row.deposits_clp, row.has_cartola)}</td>
              <td className="mono desktop-only">{fmtMoney(row.withdrawals_clp, row.has_cartola)}</td>
              <td
                className="mono desktop-only"
                title={emptyImport ? t("accountDetail.checking.cartolaRegisteredNoMovements") : undefined}
              >
                {row.has_cartola ? row.movement_count : "—"}
              </td>
              <td className="mono desktop-only">
                {row.balance_end_clp != null ? formatClp(row.balance_end_clp) : "—"}
              </td>
              <td className="mono muted desktop-only">
                {row.cartola_saldo_final_clp != null
                  ? formatClp(row.cartola_saldo_final_clp)
                  : "—"}
              </td>
              <td className="mono desktop-only">{diff != null ? formatClp(diff) : "—"}</td>
              <td className="mono desktop-only" title={row.source_file || undefined}>
                {row.has_cartola
                  ? t("accountDetail.checking.cartolaYes")
                  : t("accountDetail.checking.cartolaNo")}
              </td>
              <td className="mobile-only">
                <CheckingCartolaMonthMobileCard
                  row={row}
                  labels={mobileLabels}
                  emptyImportTitle={
                    emptyImport ? t("accountDetail.checking.cartolaRegisteredNoMovements") : undefined
                  }
                />
              </td>
            </tr>
          );
        })}
      </Table>
    </>
  );
}
