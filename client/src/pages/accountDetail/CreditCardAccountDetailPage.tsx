import { useTranslation } from "../../i18n";
import {
  CreditCardDetalleSurface,
  CreditCardFinancingSurface,
  CreditCardHistorialSurface,
  type CcSurfaceScope,
} from "../../components/liabilities/CreditCardLedgerSurfaces";
import { AccountFlowsSection } from "../../components/account/AccountFlowsSection";
import { CreditCardSummaryCards } from "../../components/liabilities/CreditCardSummaryCards";
import { cn } from "../../cn";
import { AccountDetailSharedLayout } from "./AccountDetailSharedLayout";
import { ExportToolbarButton } from "../../components/export/ExportModal";
import { AccountImportSection } from "../../components/account/AccountImportSection";
import { CreditCardConfigSection } from "../../components/account/CreditCardConfigSection";
import { CreditCardDetailSections } from "./CreditCardSections";
import type { AccountDetailPageData } from "./useAccountDetailPageData";
import { movementUnitsKind } from "./shared";
import styles from "../AccountDetailPage.module.css";

type Props = {
  data: AccountDetailPageData;
};

export function CreditCardAccountDetailPage({ data }: Props) {
  const { t } = useTranslation();
  const {
    summary,
    ts,
    ccLedger,
    displayUnit,
    extraCcOffsets,
    setExtraCcOffsets,
  } = data;

  // The historial chart, the financing chart and the detalle table each own a per-surface
  // Período/Rango control (`cc.<id>.historial` D/M/Y, `.financing` and `.detalle` M/Y) —
  // the same trio the Pasivos / credit-card group pages render (`CreditCardLedgerSurfaces`).
  const ccScope: CcSurfaceScope = { variant: "account", accountId: summary.account_id };

  const heroClp =
    displayUnit === "usd"
      ? 0
      : data.accountDashRow?.current_value_clp ?? summary.latest_valuation_clp ?? ccLedger.totals.total_remaining_principal_clp;

  return (
    <AccountDetailSharedLayout
      title={ts.name}
      accountId={summary.account_id}
      accountMetricsAgg={data.accountMetricsAgg}
      displayUnit={displayUnit}
      heroClp={heroClp}
      heroApiUsd={displayUnit === "usd" ? data.accountDashRow?.current_value_usd ?? data.chartUsdVal : null}
      dash={data.dash}
      accountNavChildren={data.accountNavChildren}
      stripDetailSlots={<CreditCardSummaryCards ccLedger={ccLedger} stripSlots />}
      toolbar={<ExportToolbarButton exportPath={`/api/accounts/${summary.account_id}/export.xlsx`} />}
      loading={data.contentLoading}
      showNavChildCards={false}
    >
      <AccountImportSection
        accountId={summary.account_id}
        displayUnit={displayUnit}
        extraCcOffsetsKey={JSON.stringify(extraCcOffsets)}
      />

      <CreditCardHistorialSurface ccLedger={ccLedger} scope={ccScope} />

      <CreditCardFinancingSurface ccLedger={ccLedger} scope={ccScope} />

      <CreditCardDetalleSurface ccLedger={ccLedger} scope={ccScope} />

      <CreditCardConfigSection accountId={summary.account_id} />

      {(ccLedger.associated_card_last4s?.length ?? 0) > 0 ? (
        <section className={styles.chartBlock}>
          <h2 className={styles.sectionTitle}>{t("accountDetail.creditCard.associatedCardsTitle")}</h2>
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

      <CreditCardDetailSections
        ledger={ccLedger}
        displayUnit={displayUnit}
        extraOffsets={extraCcOffsets}
        accountId={summary.account_id}
        onExtraOffsetsChange={setExtraCcOffsets}
      />

      <AccountFlowsSection
        hint={
          <p className={cn("muted", styles.proseMutedXs)}>{t("accountDetail.creditCard.flowsHint")}</p>
        }
        accountId={summary.account_id}
        movementUnitsKind={movementUnitsKind}
      />
    </AccountDetailSharedLayout>
  );
}
