import { Link } from "react-router-dom";
import { useTranslation } from "../../i18n";
import { cn } from "../../cn";
import type { AccountCcInstallmentsResponse } from "../../types";
import {
  CreditCardDetalleSurface,
  CreditCardHistorialSurface,
  type CcSurfaceScope,
} from "./CreditCardLedgerSurfaces";
import { CreditCardSummaryCards } from "./CreditCardSummaryCards";
import styles from "../../pages/AccountDetailPage.module.css";

type Props = {
  ccLedger: AccountCcInstallmentsResponse;
  /**
   * Portfolio-group slug of the page (Pasivos root, the credit-card group or one issuer):
   * scopes the persisted per-surface prefs (`liab.cc.<slug>.*`) and the day-period daily-series
   * fetch (whose CC block the server sums over the same masters as this merged ledger).
   */
  portfolioGroup: string;
  sectionTitle?: string;
  sectionHint?: string;
  linkTo?: string;
};

export function LiabilitiesCreditCardGroupSection({
  ccLedger,
  portfolioGroup,
  sectionTitle,
  sectionHint,
  linkTo,
}: Props) {
  const { t } = useTranslation();
  const ccScope: CcSurfaceScope = { variant: "group", portfolioGroup };

  const title = sectionTitle ?? t("groupPage.pasivos.creditCardSectionTitle");
  const hint = sectionHint ?? t("groupPage.pasivos.creditCardSectionHint");

  return (
    <section className={styles.chartBlock}>
      {linkTo ? (
        <h2 className={styles.sectionTitle}>
          <Link to={linkTo}>{title}</Link>
        </h2>
      ) : (
        <h2 className={styles.sectionTitle}>{title}</h2>
      )}
      <p className={cn("muted", styles.proseSmTight)}>{hint}</p>

      <CreditCardSummaryCards ccLedger={ccLedger} />

      {(ccLedger.associated_card_last4s?.length ?? 0) > 0 ? (
        <section className={styles.chartBlock}>
          <h3 className={styles.subsectionTitleMid}>{t("accountDetail.creditCard.associatedCardsTitle")}</h3>
          <p className={cn("muted", styles.proseSmTight)}>{t("accountDetail.creditCard.associatedCardsHint")}</p>
          <ul className={styles.proseSmTight}>
            {ccLedger.associated_card_last4s!.map((last4) => (
              <li key={last4} className="mono">
                ·{last4}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <CreditCardHistorialSurface ccLedger={ccLedger} scope={ccScope} />

      <CreditCardDetalleSurface ccLedger={ccLedger} scope={ccScope} />
    </section>
  );
}
