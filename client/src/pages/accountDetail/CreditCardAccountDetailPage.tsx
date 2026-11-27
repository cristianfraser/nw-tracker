import { useTranslation } from "../../i18n";
import {
  CreditCardDetalleSurface,
  CreditCardHistorialSurface,
  type CcSurfaceScope,
} from "../../components/liabilities/CreditCardLedgerSurfaces";
import { AccountFlowsSection } from "../../components/account/AccountFlowsSection";
import { CreditCardGlance } from "../../components/credit-card/CreditCardGlance";
import { AccountDetailSharedLayout } from "./AccountDetailSharedLayout";
import { PageGridTile } from "../../components/layout/PageGridTile";
import { ExportToolbarButton } from "../../components/export/ExportModal";
import { AccountImportSection } from "../../components/account/AccountImportSection";
import { CreditCardConfigSection } from "../../components/account/CreditCardConfigSection";
import { CreditCardDetailSections } from "./CreditCardSections";
import type { AccountDetailPageData } from "./useAccountDetailPageData";
import styles from "../AccountDetailPage.module.css";

type Props = {
  data: AccountDetailPageData;
};

export function CreditCardAccountDetailPage({ data }: Props) {
  const { t } = useTranslation();
  const { summary, ts, ccLedger } = data;

  // The historial chart and the detalle table each own a per-surface Período control
  // (`cc.<id>.historial` D/M/Y + Rango, `.detalle` M/Y) — the same pair the Pasivos /
  // credit-card group pages render (`CreditCardLedgerSurfaces`).
  const ccScope: CcSurfaceScope = { variant: "account", accountId: summary.account_id };

  // The card's own summary in the hero strip's place: the open and previous facturación, the cupo per currency.
  return (
    <AccountDetailSharedLayout
      title={ts.name}
      strip={ccLedger.glance === null ? null : <CreditCardGlance accountId={summary.account_id} glance={ccLedger.glance} />}
      toolbar={<ExportToolbarButton exportPath={`/api/accounts/${summary.account_id}/export.xlsx`} />}
      loading={data.contentLoading}
    >
      <AccountImportSection accountId={summary.account_id} />

      <CreditCardHistorialSurface ccLedger={ccLedger} scope={ccScope} loading={data.contentLoading} />

      <CreditCardDetalleSurface ccLedger={ccLedger} scope={ccScope} loading={data.contentLoading} />

      <CreditCardConfigSection accountId={summary.account_id} />

      {(ccLedger.associated_card_last4s?.length ?? 0) > 0 ? (
        <PageGridTile id="cc-associated-cards">
          <h2>{t("accountDetail.creditCard.associatedCardsTitle")}</h2>
          <ul className={styles.proseSmTight}>
            {ccLedger.associated_card_last4s!.map((last4) => (
              <li key={last4} className="mono">
                ·{last4}
              </li>
            ))}
          </ul>
        </PageGridTile>
      ) : null}

      <CreditCardDetailSections
        ledger={ccLedger}
        accountId={summary.account_id}
        loading={data.contentLoading}
      />

      <AccountFlowsSection
        accountId={summary.account_id}
      />
    </AccountDetailSharedLayout>
  );
}
