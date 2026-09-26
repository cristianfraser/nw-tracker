import { useTranslation } from "react-i18next";
import { AccountBookMovementsForm } from "./AccountBookMovementsForm";
import { AccountBookValuationForm } from "./AccountBookValuationForm";
import type { DisplayUnit } from "../../queries/keys";
import styles from "../../pages/AccountDetailPage.module.css";
import { cn } from "../../cn";

type Props = {
  accountId: number;
  displayUnit: DisplayUnit;
};

export function AccountBookLedgerSection({ accountId, displayUnit }: Props) {
  const { t } = useTranslation();

  return (
    <section className={styles.sectionTitleSpaced}>
      <h2>{t("accountDetail.bookLedger.sectionTitle")}</h2>
      <p className={cn("muted", styles.proseMutedXs)}>{t("accountDetail.bookLedger.sectionHint")}</p>
      <AccountBookValuationForm
        accountId={accountId}
        displayUnit={displayUnit}
      />
      <AccountBookMovementsForm
        accountId={accountId}
        displayUnit={displayUnit}
      />
    </section>
  );
}
