import { useCallback, useMemo, useState } from "react";
import { useTranslation } from "../../i18n";
import { formatClp } from "../../format";
import { Modal } from "../../components/ui/Modal";
import { useFlowsCreditCardExpenses } from "../../queries/hooks";
import { formatYmEs } from "./shared";
import { mergedFacturacionLines } from "./mergedFacturacionLines";
import type { CcFacturacionDto, CcStatementDto } from "../../types";
import { Table } from "../../components/ui/Table";
import { CreditCardFacturacionModalSections } from "../../components/credit-card/CreditCardFacturacionModalSections";
import {
  buildFacturacionModalBucket,
  emptyFacturacionModalBucket,
} from "../../components/credit-card/buildFacturacionModalBucket";
import { flowLinesForBillingStatementMonth } from "../../components/credit-card/flowLinesForStatementMonth";
import { deletableWebPasteLineIds } from "../../components/credit-card/deletableWebPasteLineIds";
import type { DisplayUnit } from "../../queries/keys";
import styles from "../AccountDetailPage.module.css";
import linkStyles from "./CreditCardFacturacionesTable.module.css";

function fmtUsd(n: number | null | undefined) {
  if (n == null || !Number.isFinite(n)) return "—";
  return `US$ ${n.toFixed(2)}`;
}

export function CreditCardFacturacionesTable({
  rows,
  statements = [],
  accountId,
  displayUnit,
  extraCcOffsetsKey,
  collapsedVisibleRows = 12,
}: {
  rows: readonly CcFacturacionDto[];
  statements?: readonly CcStatementDto[];
  accountId: number;
  displayUnit: DisplayUnit;
  extraCcOffsetsKey: string;
  collapsedVisibleRows?: number;
}) {
  const { t } = useTranslation();
  const { data: flows } = useFlowsCreditCardExpenses();
  const categories = flows?.categories ?? [];
  const hidden = Math.max(0, rows.length - collapsedVisibleRows);
  const [modalOpen, setModalOpen] = useState(false);
  const [selected, setSelected] = useState<CcFacturacionDto | null>(null);

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
    return flowLinesForBillingStatementMonth(
      flows.lines,
      statements,
      accountId,
      selected.billing_month
    );
  }, [accountId, flows, selected, statements]);

  const statementLineCount = useMemo(() => {
    if (!selected) return 0;
    return mergedFacturacionLines(statements, selected.billing_month).length;
  }, [selected, statements]);

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
        <>
          {" "}
          · {t("account.creditCard.colFacturadoTotal")}: {formatClp(selected.facturado_total_clp)}
        </>
      ) : null}
    </>
  ) : null;

  return (
    <>
      <Table
        wrapClassName={styles.tableWrapSpaced}
        tableClassName={styles.tableCompact}
        collapsedVisibleRows={collapsedVisibleRows}
        showMoreLabel={t("table.showMoreMonths", { count: hidden })}
        showLessLabel={t("table.showLessMonths")}
        header={
          <thead>
            <tr>
              <th>{t("account.creditCard.colBillingMonth")}</th>
              <th>{t("accountDetail.creditCard.colCloseDate")}</th>
              <th>{t("accountDetail.creditCard.colPayBy")}</th>
              <th>{t("account.creditCard.colFacturado")}</th>
              <th>{t("accountDetail.creditCard.colFacturadoUsd")}</th>
              <th>{t("accountDetail.creditCard.colFacturadoUsdClp")}</th>
              <th>{t("account.creditCard.colFacturadoTotal")}</th>
              <th>{t("accountDetail.creditCard.colCuotaAPagar")}</th>
            </tr>
          </thead>
        }
      >
        {rows.map((row) => (
          <tr key={row.billing_month}>
            <td className="mono">
              <button
                type="button"
                className={linkStyles.dateLink}
                onClick={() => openFacturacion(row)}
              >
                {row.billing_month} ({formatYmEs(row.billing_month)})
              </button>
            </td>
            <td className="mono">{row.close_date}</td>
            <td className="mono">{row.pay_by ?? "—"}</td>
            <td className="mono">
              {row.facturado_clp != null ? formatClp(row.facturado_clp) : "—"}
            </td>
            <td className="mono">{fmtUsd(row.facturado_usd)}</td>
            <td className="mono">
              {row.facturado_usd_clp != null ? formatClp(row.facturado_usd_clp) : "—"}
            </td>
            <td className="mono">
              {row.facturado_total_clp != null ? formatClp(row.facturado_total_clp) : "—"}
            </td>
            <td className="mono">
              {row.cuota_a_pagar_clp != null ? formatClp(row.cuota_a_pagar_clp) : "—"}
            </td>
          </tr>
        ))}
      </Table>

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
        {statementLineCount === 0 ? (
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
