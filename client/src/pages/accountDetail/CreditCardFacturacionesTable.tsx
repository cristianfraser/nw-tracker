import { useCallback, useMemo, useState } from "react";
import { useTranslation } from "../../i18n";
import { formatClp } from "../../format";
import { Modal } from "../../components/Modal";
import { formatYmEs } from "./shared";
import { mergedFacturacionLines } from "./mergedFacturacionLines";
import type { CcFacturacionDto, CcStatementDto } from "../../types";
import { Table } from "../../components/Table";
import styles from "../AccountDetailPage.module.css";
import linkStyles from "./CreditCardFacturacionesTable.module.css";

function fmtUsd(n: number | null | undefined) {
  if (n == null || !Number.isFinite(n)) return "—";
  return `US$ ${n.toFixed(2)}`;
}

function fmtOrigAmount(
  amountOrig: number | null | undefined,
  origCurrency: string | null | undefined
) {
  if (amountOrig == null || !Number.isFinite(amountOrig)) return "—";
  const ccy = (origCurrency ?? "").toUpperCase();
  if (ccy === "CLP") return formatClp(Math.round(amountOrig));
  if (ccy === "GBP") return `£${amountOrig.toFixed(2)}`;
  if (ccy === "EUR") return `€${amountOrig.toFixed(2)}`;
  if (ccy === "USD") return `US$ ${amountOrig.toFixed(2)}`;
  if (ccy) return `${amountOrig.toFixed(2)} ${ccy}`;
  return String(amountOrig);
}

export function CreditCardFacturacionesTable({
  rows,
  statements = [],
  collapsedVisibleRows = 12,
}: {
  rows: readonly CcFacturacionDto[];
  statements?: readonly CcStatementDto[];
  collapsedVisibleRows?: number;
}) {
  const { t } = useTranslation();
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

  const modalLines = useMemo(() => {
    if (!selected) return [];
    return mergedFacturacionLines(statements, selected.billing_month);
  }, [statements, selected]);

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
              <th>{t("accountDetail.creditCard.colFacturadoTotal")}</th>
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
        {modalLines.length === 0 ? (
          <p className="muted">{t("accountDetail.creditCard.facturacionModalEmpty")}</p>
        ) : (
          <Table
            tableClassName={styles.tableCompact}
            header={
              <thead>
                <tr>
                  <th>{t("account.creditCard.lineDate")}</th>
                  <th>{t("accountDetail.creditCard.colCardCurrency")}</th>
                  <th>{t("account.creditCard.lineMerchant")}</th>
                  <th>{t("account.creditCard.lineOrig")}</th>
                  <th>{t("account.creditCard.lineAmountClp")}</th>
                  <th>{t("account.creditCard.lineAmountUsd")}</th>
                </tr>
              </thead>
            }
          >
            {modalLines.map((ln) => (
              <tr key={`${ln.statement_id}-${ln.id}`}>
                <td className="mono">{ln.transaction_date ?? ln.posting_date ?? "—"}</td>
                <td className="mono">{ln.currency.toUpperCase()}</td>
                <td>{ln.merchant ?? ln.description_merged ?? "—"}</td>
                <td className="mono">{fmtOrigAmount(ln.amount_orig, ln.orig_currency)}</td>
                <td className="mono">
                  {ln.amount_clp != null && ln.amount_clp !== 0
                    ? formatClp(ln.amount_clp)
                    : ln.currency === "usd"
                      ? "—"
                      : ln.amount_clp === 0
                        ? "—"
                        : formatClp(0)}
                </td>
                <td className="mono">
                  {ln.amount_usd != null && Number.isFinite(ln.amount_usd)
                    ? `US$ ${ln.amount_usd.toFixed(2)}`
                    : "—"}
                </td>
              </tr>
            ))}
          </Table>
        )}
      </Modal>
    </>
  );
}
