import type { ReactNode } from "react";
import type { CcInstallmentPurchaseComputed } from "../../types";
import { formatClp, formatGroupedDecimal } from "../../format";
import { cn } from "../../cn";
import { useTranslation } from "../../i18n";
import {
  TableMobileCard,
  TableMobileCardRow,
  TableMobileCardSection,
} from "../../components/ui/TableMobileCard";
import { formatYearMonthLabel } from "../../formatDateLabel";
import { CreditCardCuotaProgress } from "./CreditCardCuotaProgress";
import styles from "../AccountDetailPage.module.css";
import { Button } from "@crfrsr/ui";

function PurchaseMeta({ children }: { children: ReactNode }) {
  return <div className={cn("muted", styles.purchaseMeta)}>{children}</div>;
}

export function CreditCardPurchaseMobileCard({
  purchase,
  hasLedger,
  dueColumn,
  originLabel,
  manualDeleteLabel,
  manualBusy,
  onDeleteManual,
  maxInstallments,
}: {
  purchase: CcInstallmentPurchaseComputed;
  hasLedger: boolean;
  dueColumn: "last" | "none";
  originLabel: string;
  manualDeleteLabel: string;
  manualBusy: boolean;
  onDeleteManual?: () => void;
  /** Shared segment width of the table's progress bars (see CreditCardCuotaProgress). */
  maxInstallments: number;
}) {
  const { t } = useTranslation();
  const title = (
    <>
      <div>{purchase.label}</div>
      <div className={cn("mono", "muted", styles.purchaseMeta)}>{purchase.purchase_id}</div>
    </>
  );

  return (
    <TableMobileCard title={title}>
      <TableMobileCardSection>
        <PurchaseMeta>{originLabel}</PurchaseMeta>
        {purchase.note ? <PurchaseMeta>{purchase.note}</PurchaseMeta> : null}
        {hasLedger && purchase.origin === "manual" && purchase.purchase_db_id != null && onDeleteManual ? (
          <Button variant="ghost"
            disabled={manualBusy}
            onClick={onDeleteManual}
          >
            {manualDeleteLabel}
          </Button>
        ) : null}
      </TableMobileCardSection>

      <TableMobileCardSection>
        <TableMobileCardRow label={t("account.creditCard.colInstallments")} value={String(purchase.installment_count)} />
        {dueColumn !== "last" ? (
          <TableMobileCardRow label={t("account.creditCard.colPaid")} value={String(purchase.installments_paid)} />
        ) : null}
        {dueColumn !== "last" ? (
          <TableMobileCardRow label={t("account.creditCard.colRemain")} value={String(purchase.remaining_installments)} />
        ) : null}
        <TableMobileCardRow label={t("account.creditCard.colPrincipal")} value={formatClp(purchase.principal_clp)} />
      </TableMobileCardSection>

      <TableMobileCardSection>
        {!hasLedger ? (
          <TableMobileCardRow
            label={t("account.creditCard.colAnnualRate")}
            value={formatGroupedDecimal(purchase.annual_interest_pct, 2)}
          />
        ) : null}
        <TableMobileCardRow label={t("account.creditCard.colPurchaseDate")} value={purchase.purchase_date ?? "—"} />
        <TableMobileCardRow
          label={t("account.creditCard.colPurchaseBillingMonth")}
          value={purchase.purchase_billing_month ?? purchase.purchase_month ?? "—"}
        />
        {dueColumn !== "last" ? (
          <TableMobileCardRow label={t("account.creditCard.colFirstDue")} value={purchase.first_due_month} />
        ) : null}
        {dueColumn === "last" ? (
          <TableMobileCardRow
            label={t("account.creditCard.colLastPaid")}
            value={purchase.last_paid_month ? formatYearMonthLabel(purchase.last_paid_month) : "—"}
          />
        ) : null}
      </TableMobileCardSection>

      {!hasLedger ? (
        <TableMobileCardSection>
          <TableMobileCardRow label={t("account.creditCard.colOffsetCsv")} value={String(purchase.schedule_offset_months)} />
        </TableMobileCardSection>
      ) : null}

      <TableMobileCardSection>
        <TableMobileCardRow label={t("account.creditCard.colCuotaClp")} value={formatClp(purchase.cuota_clp)} />
        {dueColumn !== "last" ? (
          <TableMobileCardRow label={t("account.creditCard.colRemainingClp")} value={formatClp(purchase.remaining_principal_clp)} />
        ) : null}
      </TableMobileCardSection>

      {dueColumn === "none" && purchase.cuota_progress ? (
        <TableMobileCardSection>
          <CreditCardCuotaProgress progress={purchase.cuota_progress} maxInstallments={maxInstallments} />
        </TableMobileCardSection>
      ) : null}
    </TableMobileCard>
  );
}

export function purchaseTableColSpan(
  hasLedger: boolean,
  dueColumn: "last" | "none"
): number {
  // Base desktop columns — "last": Compra, Cuotas, Principal, Fecha, Mes facturación,
  // Cuota CLP, Mes último pago; "none" swaps the último-pago column for Pagadas, Restan,
  // 1.ª cuota, Restante CLP. Without a ledger the Tasa + Offset CSV columns are added.
  // +1 = the mobile-only cell.
  const desktop = (dueColumn === "last" ? 7 : 10) + (hasLedger ? 0 : 2);
  return desktop + 1;
}
