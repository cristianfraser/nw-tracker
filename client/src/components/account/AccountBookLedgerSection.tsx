import { useTranslation } from "react-i18next";
import { AccountBookMovementsForm } from "./AccountBookMovementsForm";
import { AccountBookValuationForm } from "./AccountBookValuationForm";
import styles from "../../pages/AccountDetailPage.module.css";
import { cn } from "../../cn";
import { PageGridTile } from "../layout/PageGridTile";

type Props = {
  accountId: number;
};

export function AccountBookLedgerSection({ accountId }: Props) {
  const { t } = useTranslation();

  return (
    <PageGridTile id="book-ledger">
      <h2>{t("accountDetail.bookLedger.sectionTitle")}</h2>
      <p className={cn("muted", styles.proseMutedXs)}>{t("accountDetail.bookLedger.sectionHint")}</p>
      <AccountBookValuationForm
        accountId={accountId}
      />
      <AccountBookMovementsForm
        accountId={accountId}
      />
    </PageGridTile>
  );
}
