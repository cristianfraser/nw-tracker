import { useCallback, useMemo, useState } from "react";
import { useTranslation } from "../../i18n";
import { formatClp } from "../../format";
import type { CheckingCartolaMonthRowDto } from "../../types";
import { Table } from "../../components/ui/Table";
import { Modal } from "../../components/ui/Modal";
import { FlowsTable } from "../../components/account/FlowsTable";
import { useAccountFlows, type FlowsQueryFilters } from "../../queries/hooks";
import { useModalPeriodNav } from "../../periodModalNav";
import { monthEndUtcYmd } from "../../calendarMonth";
import {
  TableMobileCard,
  TableMobileCardRow,
  TableMobileCardSection,
} from "../../components/ui/TableMobileCard";
import { formatYmEs } from "./shared";

const MODAL_PAGE_SIZE = 20;

const periodKeyOf = (row: CheckingCartolaMonthRowDto) => row.period_month;

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
  onOpen,
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
  onOpen: (row: CheckingCartolaMonthRowDto) => void;
}) {
  const diff = cartolaBalanceDiff(row);
  const title = (
    <button type="button" onClick={() => onOpen(row)}>
      {row.as_of_date} ({formatYmEs(row.period_month)})
    </button>
  );

  return (
    <TableMobileCard title={title}>
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
  accountId,
  importedMonthCount,
  collapsedVisibleRows = 12,
}: {
  rows: readonly CheckingCartolaMonthRowDto[];
  accountId: number;
  importedMonthCount: number;
  collapsedVisibleRows?: number;
}) {
  const { t } = useTranslation();
  const hidden = Math.max(0, rows.length - collapsedVisibleRows);

  const [modalOpen, setModalOpen] = useState(false);
  const [selected, setSelected] = useState<CheckingCartolaMonthRowDto | null>(null);
  const [modalPage, setModalPage] = useState(1);

  const openMonth = useCallback((row: CheckingCartolaMonthRowDto) => {
    setSelected(row);
    setModalPage(1);
    setModalOpen(true);
  }, []);

  const closeModal = useCallback(() => {
    setModalOpen(false);
    setSelected(null);
  }, []);

  const selectMonth = useCallback((row: CheckingCartolaMonthRowDto) => {
    setSelected(row);
    setModalPage(1);
  }, []);

  const titleNav = useModalPeriodNav({
    rows,
    selectedKey: selected?.period_month ?? null,
    keyOf: periodKeyOf,
    onSelect: selectMonth,
    labels: { prev: t("common.modalPrevPeriod"), next: t("common.modalNextPeriod") },
  });

  const flowFilters = useMemo(
    (): FlowsQueryFilters => ({
      page: modalPage,
      pageSize: MODAL_PAGE_SIZE,
      date_from: selected ? `${selected.period_month}-01` : undefined,
      date_to: selected ? monthEndUtcYmd(selected.period_month) : undefined,
    }),
    [modalPage, selected]
  );
  const { data: flows, isFetching: flowsFetching } = useAccountFlows(
    String(accountId),
    flowFilters,
    modalOpen && selected != null && accountId > 0
  );

  const selectedDiff = selected ? cartolaBalanceDiff(selected) : null;

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
                <button
                  type="button"
                  onClick={() => openMonth(row)}
                >
                  {row.as_of_date} ({formatYmEs(row.period_month)})
                </button>
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
                  onOpen={openMonth}
                />
              </td>
            </tr>
          );
        })}
      </Table>

      <Modal
        open={modalOpen}
        onClose={closeModal}
        closeAriaLabel={t("accountDetail.checking.monthModalClose")}
        titleNav={titleNav}
        title={
          selected
            ? t("accountDetail.checking.monthModalTitle", {
                month: formatYmEs(selected.period_month),
              })
            : ""
        }
        subtitle={
          selected ? (
            <>
              <span className="mono">{selected.as_of_date}</span>
              {" · "}
              {mobileLabels.deposits}: {fmtMoney(selected.deposits_clp, selected.has_cartola)}
              {" · "}
              {mobileLabels.withdrawals}: {fmtMoney(selected.withdrawals_clp, selected.has_cartola)}
              {" · "}
              {mobileLabels.balanceEnd}:{" "}
              {selected.balance_end_clp != null ? formatClp(selected.balance_end_clp) : "—"}
              {selectedDiff != null ? (
                <>
                  {" · "}
                  {mobileLabels.diff}: {formatClp(selectedDiff)}
                </>
              ) : null}
            </>
          ) : null
        }
      >
        <FlowsTable
          rows={flows?.rows ?? []}
          total={flows?.total ?? 0}
          page={flows?.page ?? modalPage}
          pageSize={MODAL_PAGE_SIZE}
          onPageChange={setModalPage}
          loading={flowsFetching}
          showUnitsColumn={false}
        />
      </Modal>
    </>
  );
}
