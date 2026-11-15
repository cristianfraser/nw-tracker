import type { CcInstallmentPurchaseComputed } from "../../types";
import { formatCardBillingPesos } from "../../formatNative";
import { TableMobileCard, TableMobileCardSection } from "../../components/ui/TableMobileCard";
import { CreditCardCuotaProgress } from "./CreditCardCuotaProgress";
import { CreditCardPurchaseVendor } from "./CreditCardPurchaseVendor";

/**
 * The card of an active plan: the desktop row's pieces stacked — the date as the title, the
 * vendor (`merchant · note · link ⓘ ⋯`), then the progress bar, whose caption leads with the
 * cuota. (The completed-plans table draws its card from its column list.)
 */
export function CreditCardPurchaseMobileCard({
  purchase,
  accountId,
  manualBusy,
  onDeleteManual,
  maxInstallments,
}: {
  purchase: CcInstallmentPurchaseComputed;
  accountId: number;
  manualBusy: boolean;
  onDeleteManual?: () => void;
  /** Shared segment width of the table's progress bars (see CreditCardCuotaProgress). */
  maxInstallments: number;
}) {
  return (
    <TableMobileCard
      title={
        <div className="mono">
          {purchase.purchase_date ?? "—"}
          {purchase.cuota_progress ? null : ` · ${formatCardBillingPesos(purchase.cuota_clp)}`}
        </div>
      }
    >
      <TableMobileCardSection>
        <CreditCardPurchaseVendor
          purchase={purchase}
          accountId={accountId}
          onDeleteManual={onDeleteManual}
          deleteBusy={manualBusy}
        />
      </TableMobileCardSection>
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

/** Columns of the active-plans table: Compra (date · cuota over the vendor), Cuotas (the progress bar), and the mobile-only cell. */
export const ACTIVE_PURCHASE_TABLE_COL_SPAN = 3;
