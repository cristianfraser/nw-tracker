import { useState } from "react";
import { Button } from "@crfrsr/ui";
import type { CcInstallmentPurchaseComputed } from "../../types";
import { useTranslation } from "../../i18n";
import { ExpensePurchaseNoteInput } from "../../components/credit-card/ExpensePurchaseNoteInput";
import {
  ExpenseRowMoreButton,
  ExpenseVendorLabel,
  ExpenseVendorPanelLink,
  expenseVendorName,
  useExpenseVendorLinkLabel,
  type ExpenseVendorSource,
} from "../../components/credit-card/ExpenseVendorLabel";
import styles from "./CreditCardPurchaseVendor.module.css";

export function purchaseVendorSource(p: CcInstallmentPurchaseComputed): ExpenseVendorSource {
  return {
    merchant: p.label,
    display_merchant: p.display_merchant,
    merchant_processor: p.merchant_processor,
    link_label: p.link_label,
    payment_receipt: p.payment_receipt,
  };
}

/**
 * A card plan's vendor, read like its expense lines (`merchant · note · link ⓘ`), with a ⋯ panel
 * holding the full link label, the note (written under the plan's `installment-h:` key, so only a
 * plan with an expense line has one), for a hand-entered plan its delete, and last the plan's id
 * and where it came from (statement or hand-entered).
 */
export function CreditCardPurchaseVendor({
  purchase,
  accountId,
  onDeleteManual,
  deleteBusy = false,
}: {
  purchase: CcInstallmentPurchaseComputed;
  accountId: number;
  onDeleteManual?: () => void;
  deleteBusy?: boolean;
}) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const source = purchaseVendorSource(purchase);
  const linkLabel = useExpenseVendorLinkLabel(source);
  const noteKey = purchase.expense_purchase_key;

  return (
    <div className={styles.root}>
      <div className={styles.line}>
        <ExpenseVendorLabel source={source} note={purchase.purchase_notes} className={styles.label} />
        <ExpenseRowMoreButton
          expanded={expanded}
          ariaLabel={t("expenses.creditCard.lineRow.moreAria", { merchant: expenseVendorName(source) })}
          onClick={() => setExpanded((v) => !v)}
        />
      </div>
      {expanded ? (
        <div className={styles.panel}>
          {linkLabel ? <ExpenseVendorPanelLink linkLabel={linkLabel} /> : null}
          {noteKey ? (
            <div className={styles.panelNote}>
              <ExpensePurchaseNoteInput
                accountId={accountId}
                purchaseKey={noteKey}
                value={purchase.purchase_notes ?? ""}
              />
            </div>
          ) : null}
          {onDeleteManual ? (
            <div>
              <Button variant="ghost" size="sm" disabled={deleteBusy} onClick={onDeleteManual}>
                {t("account.creditCard.manualDelete")}
              </Button>
            </div>
          ) : null}
          <div className={styles.panelMeta}>
            <div className="mono">{purchase.purchase_id}</div>
            <div>
              {purchase.origin === "manual"
                ? t("account.creditCard.originManual")
                : t("account.creditCard.originImportDocument")}
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
