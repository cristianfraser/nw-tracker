import { useCallback, useMemo, useState } from "react";
import { useTranslation } from "../../i18n";
import { formatClp, formatOrDash } from "../../format";
import { cn } from "../../cn";
import { Modal } from "../../components/ui/Modal";
import { useFlowsCreditCardExpenses } from "../../queries/hooks";
import { formatYmEs } from "./shared";
import type { CcFacturacionDto, CcStatementDto } from "../../types";
import { PaginatedTable, useClientPagination } from "../../components/ui/PaginatedTable";
import { Table } from "../../components/ui/Table";
import { CreditCardFacturacionModalSections } from "../../components/credit-card/CreditCardFacturacionModalSections";
import {
  buildFacturacionModalBucket,
  emptyFacturacionModalBucket,
} from "../../components/credit-card/buildFacturacionModalBucket";
import { flowLinesForFacturacionMonth } from "../../components/credit-card/flowLinesForStatementMonth";
import { deletableWebPasteLineIds } from "../../components/credit-card/deletableWebPasteLineIds";
import type { DisplayUnit } from "../../queries/keys";
import {
  TableMobileCard,
  TableMobileCardRow,
  TableMobileCardSection,
} from "../../components/ui/TableMobileCard";
import styles from "../AccountDetailPage.module.css";
import linkStyles from "./CreditCardFacturacionesTable.module.css";

function fmtUsd(n: number | null | undefined) {
  if (n == null || !Number.isFinite(n)) return "—";
  return `US$ ${n.toFixed(2)}`;
}

function FacturacionMobileCard({
  row,
  labels,
  onOpen,
}: {
  row: CcFacturacionDto;
  labels: {
    closeDate: string;
    payBy: string;
    facturado: string;
    facturadoUsd: string;
    facturadoUsdClp: string;
    facturadoTotal: string;
    cuotaAPagar: string;
  };
  onOpen: (row: CcFacturacionDto) => void;
}) {
  const title = (
    <button type="button" className={linkStyles.dateLink} onClick={() => onOpen(row)}>
      {row.billing_month} ({formatYmEs(row.billing_month)})
    </button>
  );

  return (
    <TableMobileCard title={title}>
      <TableMobileCardSection>
        <TableMobileCardRow label={labels.closeDate} value={row.close_date} />
        <TableMobileCardRow label={labels.payBy} value={row.pay_by ?? "—"} />
      </TableMobileCardSection>
      <TableMobileCardSection>
        <TableMobileCardRow
          label={labels.facturado}
          value={formatOrDash(row.facturado_clp, formatClp)}
        />
        <TableMobileCardRow label={labels.facturadoUsd} value={fmtUsd(row.facturado_usd)} />
        <TableMobileCardRow
          label={labels.facturadoUsdClp}
          value={formatOrDash(row.facturado_usd_clp, formatClp)}
        />
        <TableMobileCardRow
          label={labels.facturadoTotal}
          value={formatOrDash(row.facturado_total_clp, formatClp)}
        />
        <TableMobileCardRow
          label={labels.cuotaAPagar}
          value={formatOrDash(row.cuota_a_pagar_clp, formatClp)}
        />
      </TableMobileCardSection>
    </TableMobileCard>
  );
}

const PAGE_SIZE = 12;

export function CreditCardFacturacionesTable({
  rows,
  statements = [],
  accountId,
  displayUnit,
  extraCcOffsetsKey,
}: {
  rows: readonly CcFacturacionDto[];
  statements?: readonly CcStatementDto[];
  accountId: number;
  displayUnit: DisplayUnit;
  extraCcOffsetsKey: string;
}) {
  const { t } = useTranslation();
  const { data: flows } = useFlowsCreditCardExpenses();
  const categories = flows?.categories ?? [];
  const [modalOpen, setModalOpen] = useState(false);
  const [selected, setSelected] = useState<CcFacturacionDto | null>(null);

  const mobileLabels = {
    closeDate: t("accountDetail.creditCard.colCloseDate"),
    payBy: t("accountDetail.creditCard.colPayBy"),
    facturado: t("account.creditCard.colFacturado"),
    facturadoUsd: t("accountDetail.creditCard.colFacturadoUsd"),
    facturadoUsdClp: t("accountDetail.creditCard.colFacturadoUsdClp"),
    facturadoTotal: t("accountDetail.creditCard.colFacturadoTotal"),
    cuotaAPagar: t("accountDetail.creditCard.colCuotaAPagar"),
  };

  const closeModal = useCallback(() => {
    setModalOpen(false);
    setSelected(null);
  }, []);

  const openFacturacion = useCallback((row: CcFacturacionDto) => {
    setSelected(row);
    setModalOpen(true);
  }, []);

  const scopedLines = useMemo(() => {
    if (!selected || !flows) return [];
    return flowLinesForFacturacionMonth(
      flows.lines,
      statements,
      accountId,
      selected
    );
  }, [accountId, flows, selected, statements]);

  const facturacionLineCount = useMemo(() => scopedLines.length, [scopedLines]);

  const facturacionBucket = useMemo(() => {
    if (!selected) return emptyFacturacionModalBucket();
    return buildFacturacionModalBucket(scopedLines);
  }, [scopedLines, selected]);

  const deletableLineIds = useMemo(() => {
    if (!selected) return new Set<number>();
    return deletableWebPasteLineIds(statements, selected.billing_month);
  }, [selected, statements]);

  const modalSubtitle = selected ? (
    <>
      <span className="mono">{selected.billing_month}</span>
      {selected.close_date ? (
        <>
          {" "}
          · {t("accountDetail.creditCard.colCloseDate")}: {selected.close_date}
        </>
      ) : null}
      {selected.pay_by ? (
        <>
          {" "}
          · {t("accountDetail.creditCard.colPayBy")}: {selected.pay_by}
        </>
      ) : null}
      {selected.facturado_total_clp != null ? (
        <> · {t("account.creditCard.colFacturadoTotal")}: {formatOrDash(selected.facturado_total_clp, formatClp)}</>
      ) : null}
    </>
  ) : null;

  const sortedRows = useMemo(
    () => [...rows].sort((a, b) => b.billing_month.localeCompare(a.billing_month)),
    [rows]
  );

  const { page, setPage, pageRows, total } = useClientPagination(sortedRows, PAGE_SIZE);

  return (
    <>
      <PaginatedTable
        page={page}
        pageSize={PAGE_SIZE}
        total={total}
        onPageChange={setPage}
        wrapClassName={styles.tableWrapSpaced}
      >
        <Table
          tableClassName={cn(styles.tableCompact, "table--parallel-mobile")}
          header={
            <thead>
              <tr>
                <th className="desktop-only">{t("account.creditCard.colBillingMonth")}</th>
                <th className="desktop-only">{t("accountDetail.creditCard.colCloseDate")}</th>
                <th className="desktop-only">{t("accountDetail.creditCard.colPayBy")}</th>
                <th className="desktop-only">{t("account.creditCard.colFacturado")}</th>
                <th className="desktop-only">{t("accountDetail.creditCard.colFacturadoUsd")}</th>
                <th className="desktop-only">{t("accountDetail.creditCard.colFacturadoUsdClp")}</th>
                <th className="desktop-only">{t("account.creditCard.colFacturadoTotal")}</th>
                <th className="desktop-only">{t("accountDetail.creditCard.colCuotaAPagar")}</th>
                <th className="mobile-only" aria-hidden="true" />
              </tr>
            </thead>
          }
        >
          {pageRows.map((row) => (
            <tr key={row.billing_month}>
              <td className="mono desktop-only">
                <button
                  type="button"
                  className={linkStyles.dateLink}
                  onClick={() => openFacturacion(row)}
                >
                  {row.billing_month} ({formatYmEs(row.billing_month)})
                </button>
              </td>
              <td className="mono desktop-only">{row.close_date}</td>
              <td className="mono desktop-only">{row.pay_by ?? "—"}</td>
              <td className="mono desktop-only">{formatOrDash(row.facturado_clp, formatClp)}</td>
              <td className="mono desktop-only">{fmtUsd(row.facturado_usd)}</td>
              <td className="mono desktop-only">{formatOrDash(row.facturado_usd_clp, formatClp)}</td>
              <td className="mono desktop-only">{formatOrDash(row.facturado_total_clp, formatClp)}</td>
              <td className="mono desktop-only">{formatOrDash(row.cuota_a_pagar_clp, formatClp)}</td>
              <td className="mobile-only">
                <FacturacionMobileCard row={row} labels={mobileLabels} onOpen={openFacturacion} />
              </td>
            </tr>
          ))}
        </Table>
      </PaginatedTable>

      <Modal
        open={modalOpen}
        onClose={closeModal}
        closeAriaLabel={t("accountDetail.creditCard.facturacionModalClose")}
        title={
          selected
            ? t("accountDetail.creditCard.facturacionModalTitle", {
                month: formatYmEs(selected.billing_month),
              })
            : ""
        }
        subtitle={modalSubtitle}
      >
        {facturacionLineCount === 0 ? (
          <p className="muted">{t("accountDetail.creditCard.facturacionModalEmpty")}</p>
        ) : (
          <CreditCardFacturacionModalSections
            bucket={facturacionBucket}
            categories={categories}
            accountId={accountId}
            displayUnit={displayUnit}
            extraCcOffsetsKey={extraCcOffsetsKey}
            deletableLineIds={deletableLineIds}
          />
        )}
      </Modal>
    </>
  );
}
