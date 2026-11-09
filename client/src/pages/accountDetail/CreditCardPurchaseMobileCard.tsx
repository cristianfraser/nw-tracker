import type { CcInstallmentPurchaseComputed } from "../../types";
import { formatClp } from "../../format";
import { useTranslation } from "../../i18n";
import {
  TableMobileCard,
  TableMobileCardRow,
  TableMobileCardSection,
} from "../../components/ui/TableMobileCard";
import { formatYearMonthLabel } from "../../formatDateLabel";
import { CreditCardCuotaProgress } from "./CreditCardCuotaProgress";
import { CreditCardPurchaseVendor } from "./CreditCardPurchaseVendor";

export function CreditCardPurchaseMobileCard({
  purchase,
  accountId,
  dueColumn,
  manualBusy,
  onDeleteManual,
  maxInstallments,
}: {
  purchase: CcInstallmentPurchaseComputed;
  accountId: number;
  dueColumn: "last" | "none";
  manualBusy: boolean;
  onDeleteManual?: () => void;
  /** Shared segment width of the table's progress bars (see CreditCardCuotaProgress). */
  maxInstallments: number;
}) {
  const { t } = useTranslation();
  const vendor = (
    <CreditCardPurchaseVendor
      purchase={purchase}
      accountId={accountId}
      onDeleteManual={onDeleteManual}
      deleteBusy={manualBusy}
    />
  );

  // Active plans: the desktop row — the date over the vendor (`merchant · note · link ⓘ ⋯`), then
  // the progress bar, whose caption leads with the cuota.
  if (dueColumn === "none") {
    return (
      <TableMobileCard
        title={
          <div className="mono">
            {purchase.purchase_date ?? "—"}
            {purchase.cuota_progress ? null : ` · ${formatClp(purchase.cuota_clp)}`}
          </div>
        }
      >
        <TableMobileCardSection>{vendor}</TableMobileCardSection>
        {purchase.cuota_progress ? (
          <TableMobileCardSection>
            <CreditCardCuotaProgress
              progress={purchase.cuota_progress}
              cuotaClp={purchase.cuota_clp}
              maxInstallments={maxInstallments}
            />
          </TableMobileCardSection>
        ) : null}
      </TableMobileCard>
    );
  }

  return (
    <TableMobileCard title={vendor}>
      <TableMobileCardSection>
        <TableMobileCardRow label={t("account.creditCard.colInstallments")} value={String(purchase.installment_count)} />
        <TableMobileCardRow label={t("account.creditCard.colPrincipal")} value={formatClp(purchase.principal_clp)} />
      </TableMobileCardSection>

      <TableMobileCardSection>
        <TableMobileCardRow label={t("account.creditCard.colPurchaseDate")} value={purchase.purchase_date ?? "—"} />
        <TableMobileCardRow
          label={t("account.creditCard.colPurchaseBillingMonth")}
          value={purchase.purchase_billing_month ?? purchase.purchase_month ?? "—"}
        />
        <TableMobileCardRow
          label={t("account.creditCard.colLastPaid")}
          value={purchase.last_paid_month ? formatYearMonthLabel(purchase.last_paid_month) : "—"}
        />
      </TableMobileCardSection>

      <TableMobileCardSection>
        <TableMobileCardRow label={t("account.creditCard.colCuotaClp")} value={formatClp(purchase.cuota_clp)} />
      </TableMobileCardSection>
    </TableMobileCard>
  );
}

export function purchaseTableColSpan(dueColumn: "last" | "none"): number {
  // "none" (active): Compra (date · cuota over the vendor), Cuotas (the progress bar).
  // "last" (completed): Compra (the vendor with its note), Cuotas, Principal, Fecha, Mes facturación,
  // Cuota CLP, Mes último pago.
  // +1 = the mobile-only cell.
  const desktop = dueColumn === "none" ? 2 : 7;
  return desktop + 1;
}
