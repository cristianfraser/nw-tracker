import { useTranslation } from "../../i18n";
import type { ExpenseLineOrigin } from "../../types";
import { BankIcon } from "../icons/BankIcon";
import { CreditCardIcon } from "../icons/CreditCardIcon";
import { DocumentIcon } from "../icons/DocumentIcon";
import { PencilIcon } from "../icons/PencilIcon";
import { HoverPopover } from "../ui/HoverPopover";

const ICON = {
  card: CreditCardIcon,
  checking: BankIcon,
  manual: PencilIcon,
  payslip: DocumentIcon,
} as const;

/** The words for where an expense line came from (the origin icon's tooltip). */
export function useExpenseOriginLabel(): (origin: ExpenseLineOrigin) => string {
  const { t } = useTranslation();
  return (origin) => {
    switch (origin.kind) {
      case "card": {
        const name = origin.account_name ?? t("expenses.creditCard.sourceCreditCard");
        const last4 = origin.card_last4 ?? "—";
        return origin.additional
          ? t("expenses.creditCard.lineRow.originCardAdditional", { name, last4 })
          : t("expenses.creditCard.lineRow.originCard", { name, last4 });
      }
      case "checking":
        return t("expenses.creditCard.lineRow.originChecking", {
          name: origin.account_name ?? t("expenses.creditCard.sourceChecking"),
        });
      case "manual":
        return t("expenses.creditCard.lineRow.originManual");
      case "payslip":
        return t("expenses.creditCard.lineRow.originPayslip");
    }
  };
}

/** An icon per origin kind (card, bank account, hand-entered, payslip); the account on hover / tap. */
export function ExpenseOriginIcon({ origin }: { origin: ExpenseLineOrigin }) {
  const label = useExpenseOriginLabel()(origin);
  const Icon = ICON[origin.kind];
  return (
    <HoverPopover ariaLabel={label} trigger={<Icon size={16} />}>
      {label}
    </HoverPopover>
  );
}
