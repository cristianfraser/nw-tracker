import type { ReactNode } from "react";
import { Table } from "../../components/ui/Table";
import type { AccountMortgageLedgerResponse, DeptoMortgageSheetRow } from "../../types";
import { formatClp, formatUfUnitsFine } from "../../format";
import { cn } from "../../cn";
import { useTranslation } from "../../i18n";
import { ClpUfSuperscriptAmount } from "./ClpUfSuperscriptAmount";
import detailStyles from "../AccountDetailPage.module.css";
import styles from "./MortgageDividendosTableV2.module.css";

function cellTxt(s: string | null | undefined) {
  if (s == null || !String(s).trim()) return "—";
  return s;
}

function cellClp(n: number | null | undefined) {
  if (n == null || !Number.isFinite(n)) return "—";
  return formatClp(n);
}

function tasaPlusLabel(n: number | null | undefined) {
  if (n == null || !Number.isFinite(n)) return "—";
  return `${n}%`;
}

function StackBlock({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className={styles.row}>
      <span className={styles.label}>{label}</span>
      <span className={styles.value}>{children}</span>
    </div>
  );
}

function PaymentColumn({ row, t }: { row: DeptoMortgageSheetRow; t: (k: string) => string }) {
  const hasAmortExt =
    (row.amortizacion_ext_clp != null && Number.isFinite(row.amortizacion_ext_clp)) ||
    (row.amortizacion_ext_uf != null && Number.isFinite(row.amortizacion_ext_uf));

  return (
    <div className={styles.cellStack}>
      <StackBlock label={t("accountDetail.mortgageDividendosV2.totalPaid")}>
        <ClpUfSuperscriptAmount clpClp={row.pago_clp} ufAmount={row.pago_uf} />
      </StackBlock>
      <StackBlock label={t("accountDetail.mortgageDividendosV2.date")}>
        <span className="mono">{row.occurred_on}</span>
      </StackBlock>
      <StackBlock label={t("accountDetail.mortgageDividendosV2.cuota")}>
        <span className={cn("mono", detailStyles.nowrap)}>{row.cuota}</span>
      </StackBlock>
      <StackBlock label={t("accountDetail.mortgageDividendosV2.insurance")}>
        <ClpUfSuperscriptAmount clpClp={row.total_seguros_clp} ufAmount={row.total_seguros_uf} />
      </StackBlock>
      <StackBlock label={t("accountDetail.mortgageDividendosV2.amortization")}>
        <div className={styles.cellStack}>
          <ClpUfSuperscriptAmount clpClp={row.amortizacion_clp} ufAmount={row.amortizacion_uf} />
          {hasAmortExt ? (
            <div>
              <span className={styles.label}>{t("accountDetail.mortgageDividendosV2.amortExtShort")}</span>
              <ClpUfSuperscriptAmount clpClp={row.amortizacion_ext_clp} ufAmount={row.amortizacion_ext_uf} />
            </div>
          ) : null}
        </div>
      </StackBlock>
      <StackBlock label={t("accountDetail.mortgageDividendosV2.interest")}>
        <ClpUfSuperscriptAmount clpClp={row.interes_clp} ufAmount={row.interes_uf} />
      </StackBlock>
    </div>
  );
}

function CreditColumn({ row, t }: { row: DeptoMortgageSheetRow; t: (k: string) => string }) {
  return (
    <div className={styles.cellStack}>
      <StackBlock label={t("accountDetail.mortgageDividendosV2.newBalance")}>
        <ClpUfSuperscriptAmount clpClp={row.restante_clp} ufAmount={row.credito_restante_uf} />
      </StackBlock>
      <StackBlock label={t("accountDetail.mortgageDividendosV2.deltaCredit")}>
        <span className="mono">{cellClp(row.delta_credito_clp)}</span>
      </StackBlock>
      <StackBlock label={t("accountDetail.mortgageDividendosV2.deltaCreditAmort")}>
        <span className="mono">{cellClp(row.delta_credito_amort_clp)}</span>
      </StackBlock>
      <StackBlock label={t("accountDetail.mortgageDividendosV2.extraCreditBlock")}>
        <div className={styles.cellStack}>
          <div>
            <span className={styles.label}>{t("accountDetail.mortgageDividendosV2.netValue")}</span>
            <ClpUfSuperscriptAmount clpClp={row.valor_neto_clp} ufAmount={row.valor_neto_uf} />
          </div>
          <div>
            <span className={styles.label}>{t("accountDetail.mortgageDividendosV2.deltaNetClp")}</span>
            <span className="mono">{cellClp(row.delta_valor_neto_clp)}</span>
          </div>
          <div>
            <span className={styles.label}>{t("accountDetail.mortgageDividendosV2.pctCreditoUf")}</span>
            <span className="mono muted">{cellTxt(row.pct_credito_uf)}</span>
          </div>
        </div>
      </StackBlock>
    </div>
  );
}

function ExtraColumn({ row, t }: { row: DeptoMortgageSheetRow; t: (k: string) => string }) {
  return (
    <div className={styles.cellStack}>
      <StackBlock label={t("accountDetail.mortgageDividendosV2.ufDay")}>
        <span className="mono">{row.uf_clp_day != null ? formatClp(Math.round(row.uf_clp_day)) : "—"}</span>
      </StackBlock>
      <StackBlock label={t("accountDetail.mortgageDividendosV2.pctDividendo")}>
        <span className="mono muted">{cellTxt(row.pct_dividendo)}</span>
      </StackBlock>
      <StackBlock label={t("accountDetail.mortgageDividendosV2.mmYy")}>
        <span className="mono muted">
          {cellTxt(row.mm_pct)} / {cellTxt(row.yy_pct)}
        </span>
      </StackBlock>
      <StackBlock label={t("accountDetail.mortgageDividendosV2.tasaPlus")}>
        <span className="mono muted">{tasaPlusLabel(row.tasa_plus)}</span>
      </StackBlock>
      <StackBlock label={t("accountDetail.mortgageDividendosV2.vivienda")}>
        <ClpUfSuperscriptAmount clpClp={row.valor_vivienda_clp} ufAmount={row.valor_vivienda_uf} />
      </StackBlock>
      <StackBlock label={t("accountDetail.mortgageDividendosV2.minUf")}>
        <span className="mono">{formatUfUnitsFine(row.min_uf)}</span>
      </StackBlock>
      <StackBlock label={t("accountDetail.mortgageDividendosV2.pagadoNetoUf")}>
        <span className="mono">{formatUfUnitsFine(row.pagado_neto_uf)}</span>
      </StackBlock>
      <StackBlock label={t("accountDetail.mortgageDividendosV2.interesesOcultos")}>
        <div className={styles.cellStack}>
          <span className="mono">{cellClp(row.interes_oculto_clp)}</span>
          <span className="mono muted">{cellClp(row.interes_oculto_b_clp)}</span>
        </div>
      </StackBlock>
      <StackBlock label={t("accountDetail.mortgageDividendosV2.interesReal")}>
        <span className="mono">{cellClp(row.interes_real_clp)}</span>
      </StackBlock>
      <StackBlock label={t("accountDetail.mortgageDividendosV2.interesCalcUf")}>
        <span className="mono">{formatUfUnitsFine(row.interes_calculado_uf)}</span>
      </StackBlock>
      <StackBlock label={t("accountDetail.mortgageDividendosV2.amortInteres")}>
        <span className="mono muted">{cellTxt(row.amort_interes_text)}</span>
      </StackBlock>
      <StackBlock label={t("accountDetail.mortgageDividendosV2.acumulados")}>
        <div className={styles.cellStack}>
          <ClpUfSuperscriptAmount clpClp={row.pago_acumulado_clp} ufAmount={null} />
          <div>
            <span className={styles.label}>{t("accountDetail.mortgageDividendosV2.amortAcum")}</span>
            <span className="mono muted">{cellClp(row.amort_acum_clp)}</span>
          </div>
          <div>
            <span className={styles.label}>{t("accountDetail.mortgageDividendosV2.intAcum")}</span>
            <span className="mono muted">{cellClp(row.interes_acum_clp)}</span>
          </div>
        </div>
      </StackBlock>
    </div>
  );
}

/** Compact 3-column view of depto dividendos sheet (same data as the wide mortgage table). */
export function MortgageDividendosTableV2({
  ledger,
  variant = "property",
}: {
  ledger: AccountMortgageLedgerResponse;
  variant?: "property" | "mortgage";
}) {
  const { t } = useTranslation();
  const isMortgageView = variant === "mortgage";
  const rowsSorted = [...ledger.rows].sort((a, b) => String(b.occurred_on).localeCompare(String(a.occurred_on)));

  return (
    <>
      <h2 className={cn(detailStyles.sectionTitle, styles.sectionTitle)}>
        {isMortgageView
          ? t("accountDetail.mortgageDividendosV2.titleMortgage")
          : t("accountDetail.mortgageDividendosV2.titleProperty")}
      </h2>
      <p className={cn("muted", detailStyles.proseMuted, styles.proseMuted)}>
        {t("accountDetail.mortgageDividendosV2.intro")}
      </p>
      <div className={styles.tableWrap}>
        <Table
          tableClassName={styles.table}
          header={
            <thead>
              <tr>
                <th>{t("accountDetail.mortgageDividendosV2.colPayment")}</th>
                <th>{t("accountDetail.mortgageDividendosV2.colCredit")}</th>
                <th>{t("accountDetail.mortgageDividendosV2.colExtra")}</th>
              </tr>
            </thead>
          }
        >
          {rowsSorted.map((row, idx) => (
            <tr key={`v2-${row.cuota}-${row.occurred_on}-${idx}`}>
              <td>
                <PaymentColumn row={row} t={t} />
              </td>
              <td>
                <CreditColumn row={row} t={t} />
              </td>
              <td>
                <ExtraColumn row={row} t={t} />
              </td>
            </tr>
          ))}
        </Table>
      </div>
    </>
  );
}
