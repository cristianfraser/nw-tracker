import { useCallback, useMemo, useState } from "react";
import { useTranslation } from "../../i18n";
import { formatCartolaPesos } from "../../formatNative";
import type { CheckingCartolaMonthRowDto } from "../../types";
import { ColumnTable, type TableColumn } from "../../components/ui/ColumnTable";
import { loadableClass } from "../../components/ui/Loadable";
import { Modal } from "../../components/ui/Modal";
import { Button } from "@crfrsr/ui";
import { FlowsTable } from "../../components/account/FlowsTable";
import { useAccountFlows, type FlowsQueryFilters } from "../../queries/hooks";
import { queryShowsLoading } from "../../queries/pageShapeReady";
import { useModalPeriodNav } from "../../periodModalNav";
import { monthEndUtcYmd } from "../../calendarMonth";
import { formatYearMonthLabel } from "../../formatDateLabel";

const MODAL_PAGE_SIZE = 20;

const periodKeyOf = (row: CheckingCartolaMonthRowDto) => row.period_month;

/** Abonos/cargos are ledger-derived for every month; dash only when the month has no movements at all. */
function fmtMoney(n: number, hasMovements: boolean): string {
  if (!hasMovements && n === 0) return "—";
  return formatCartolaPesos(n);
}

function cartolaMonthHasEmptyImport(row: CheckingCartolaMonthRowDto): boolean {
  return row.has_cartola && row.deposits_clp === 0 && row.withdrawals_clp === 0;
}

/** Ledger month-end balance minus parsed cartola saldo final (reference). */
function cartolaBalanceDiff(row: CheckingCartolaMonthRowDto): number | null {
  if (row.balance_end_clp == null || row.cartola_saldo_final_clp == null) return null;
  return row.balance_end_clp - row.cartola_saldo_final_clp;
}

export function CheckingCartolaMonthTable({
  rows,
  accountId,
  importedMonthCount,
  collapsedVisibleRows = 12,
  loading = false,
}: {
  rows: readonly CheckingCartolaMonthRowDto[];
  accountId: number;
  importedMonthCount: number;
  collapsedVisibleRows?: number;
  /** The months are not in yet (or are held prior data): the table dims; with no rows it shows its header only, never the empty copy. */
  loading?: boolean;
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
  const flowsQuery = useAccountFlows(
    String(accountId),
    flowFilters,
    modalOpen && selected != null && accountId > 0
  );
  const flows = flowsQuery.data;

  const selectedDiff = selected ? cartolaBalanceDiff(selected) : null;

  const labels = {
    deposits: t("accountDetail.checking.colDeposits"),
    withdrawals: t("accountDetail.checking.colWithdrawals"),
    balanceEnd: t("accountDetail.checking.colBalanceEnd"),
    diff: t("accountDetail.checking.colDiff"),
  };
  const emptyImportTitle = (row: CheckingCartolaMonthRowDto) =>
    cartolaMonthHasEmptyImport(row) ? t("accountDetail.checking.cartolaRegisteredNoMovements") : undefined;
  const movementCount = (row: CheckingCartolaMonthRowDto) =>
    row.movement_count > 0 || row.has_cartola ? row.movement_count : "—";
  const cartolaFlag = (row: CheckingCartolaMonthRowDto) =>
    row.has_cartola ? t("accountDetail.checking.cartolaYes") : t("accountDetail.checking.cartolaNo");
  const columns: TableColumn<CheckingCartolaMonthRowDto>[] = [
    {
      key: "month",
      header: t("accountDetail.monthCloseColumn"),
      className: "mono",
      cell: (row) => (
        <Button variant="link" onClick={() => openMonth(row)}>
          {row.as_of_date} ({formatYearMonthLabel(row.period_month)})
        </Button>
      ),
      title: true,
    },
    {
      key: "deposits",
      header: labels.deposits,
      className: "mono",
      cell: (row) => fmtMoney(row.deposits_clp, row.movement_count > 0),
    },
    {
      key: "withdrawals",
      header: labels.withdrawals,
      className: "mono",
      cell: (row) => fmtMoney(row.withdrawals_clp, row.movement_count > 0),
    },
    {
      key: "movements",
      header: t("accountDetail.checking.colMovements"),
      className: "mono",
      cellProps: (row) => ({ title: emptyImportTitle(row) }),
      cell: movementCount,
      card: (row) => <span title={emptyImportTitle(row)}>{movementCount(row)}</span>,
    },
    {
      key: "balanceEnd",
      header: labels.balanceEnd,
      className: "mono",
      section: 1,
      cell: (row) => (row.balance_end_clp != null ? formatCartolaPesos(row.balance_end_clp) : "—"),
    },
    {
      key: "cartolaSaldo",
      header: t("accountDetail.checking.colCartolaSaldo"),
      className: "mono muted",
      section: 1,
      cell: (row) => (row.cartola_saldo_final_clp != null ? formatCartolaPesos(row.cartola_saldo_final_clp) : "—"),
    },
    {
      key: "diff",
      header: labels.diff,
      className: "mono",
      section: 1,
      cell: (row) => {
        const diff = cartolaBalanceDiff(row);
        return diff != null ? formatCartolaPesos(diff) : "—";
      },
    },
    {
      key: "cartola",
      header: t("accountDetail.checking.colCartola"),
      className: "mono",
      section: 2,
      cellProps: (row) => ({ title: row.source_file || undefined }),
      cell: cartolaFlag,
      card: (row) => <span title={row.source_file || undefined}>{cartolaFlag(row)}</span>,
    },
  ];

  if (rows.length === 0 && !loading) {
    return <p className="muted">{t("accountDetail.checking.cartolaMonthEmpty")}</p>;
  }

  return (
    <>
      {rows.length === 0 ? null : (
        <p className="muted" style={{ fontSize: "var(--font-size-ui)", margin: 0 }}>
          {t("accountDetail.checking.cartolaMonthImportedCount", {
            imported: importedMonthCount,
            total: rows.length,
          })}
        </p>
      )}
      <ColumnTable
        rows={rows}
        columns={columns}
        rowKey={(row) => row.period_month}
        wrapClassName={loadableClass(loading)}
        collapsedVisibleRows={collapsedVisibleRows}
        showMoreLabel={t("table.showMoreMonths", { count: hidden })}
        showLessLabel={t("table.showLessMonths")}
      />

      <Modal
        open={modalOpen}
        onClose={closeModal}
        closeAriaLabel={t("accountDetail.checking.monthModalClose")}
        titleNav={titleNav}
        title={
          selected
            ? t("accountDetail.checking.monthModalTitle", {
                month: formatYearMonthLabel(selected.period_month),
              })
            : ""
        }
        subtitle={
          selected ? (
            <>
              <span className="mono">{selected.as_of_date}</span>
              {" · "}
              {labels.deposits}: {fmtMoney(selected.deposits_clp, selected.movement_count > 0)}
              {" · "}
              {labels.withdrawals}: {fmtMoney(selected.withdrawals_clp, selected.movement_count > 0)}
              {" · "}
              {labels.balanceEnd}:{" "}
              {selected.balance_end_clp != null ? formatCartolaPesos(selected.balance_end_clp) : "—"}
              {selectedDiff != null ? (
                <>
                  {" · "}
                  {labels.diff}: {formatCartolaPesos(selectedDiff)}
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
          loading={queryShowsLoading(flowsQuery)}
          showUnitsColumn={false}
        />
      </Modal>
    </>
  );
}
