import type { CcInstallmentPurchaseComputed } from "../../types";
import { ExpensePurchaseNoteInput } from "../../components/credit-card/ExpensePurchaseNoteInput";
import { PaymentReceiptLine } from "../../components/flows/PaymentReceiptLine";

/**
 * A card plan's note (the one its expense lines carry, editable here too) and its receipt link.
 * A plan with no expense line has no key to write a note under: «—» unless it has a link.
 */
export function CreditCardPurchaseNotes({
  purchase,
  accountId,
}: {
  purchase: CcInstallmentPurchaseComputed;
  accountId: number;
}) {
  return (
    <>
      {purchase.expense_purchase_key ? (
        <ExpensePurchaseNoteInput
          accountId={accountId}
          purchaseKey={purchase.expense_purchase_key}
          value={purchase.purchase_notes ?? ""}
        />
      ) : purchase.payment_receipt ? null : (
        <span className="muted">—</span>
      )}
      <PaymentReceiptLine receipt={purchase.payment_receipt} />
    </>
  );
}
