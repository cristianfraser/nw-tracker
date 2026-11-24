import { useState } from "react";
import { useTranslation } from "../../i18n";
import { AccountDetailSharedLayout } from "./AccountDetailSharedLayout";
import { PageGridTile } from "../../components/layout/PageGridTile";
import { AccountFlowsSection } from "../../components/account/AccountFlowsSection";
import { AccountImportSection } from "../../components/account/AccountImportSection";
import { MortgagePaymentForm } from "../../components/account/MortgagePaymentForm";
import { DeptoHeader } from "../../components/depto/DeptoHeader";
import { DeptoMovementsToggle, DeptoPropertyBands } from "../../components/depto/DeptoPropertyGlance";
import { DeptoBalanceBand, DeptoProjection } from "../../components/depto/DeptoMortgageGlance";
import { DeptoPaymentsList } from "../../components/depto/DeptoPaymentsList";
import { Modal } from "../../components/ui/Modal";
import { loadableClass } from "../../components/ui/Loadable";
import { useAccountMovementForm } from "./accountSurfaces";
import { isDeptoMortgageCategory } from "./shared";
import type { AccountDetailPageData } from "./useAccountDetailPageData";

/**
 * A property or its mortgage (server `depto_glance`, `deptoGlance.ts`): one header (the hero in the
 * loan currency, the día / mes / año / total strip), then the property's value, P/L and
 * cost-of-living bands, or the mortgage's payments list, balance band and payoff projection. The
 * page only picks and formats. While the bundle is pending the frames render dimmed (the page kind
 * from the account's category); a loan with no ledger rows (`depto_glance` null) shows that.
 */
export function DeptoAccountDetailPage({ data }: { data: AccountDetailPageData }) {
  const { t } = useTranslation();
  const { summary, displayUnit } = data;
  const loading = data.contentLoading;
  const glance = data.deptoGlance;
  const isMortgage = glance ? glance.kind === "mortgage" : isDeptoMortgageCategory(summary.category_slug);
  const { form: addMovementsForm } = useAccountMovementForm(data);
  const [flowsOpen, setFlowsOpen] = useState(false);
  const [paymentOpen, setPaymentOpen] = useState(false);
  const unit = glance?.unit ?? displayUnit;
  // Undefined while the bundle is pending: the bands render their frames and format nothing.
  const loanCurrency = glance?.loan_currency;
  const payCurrency = glance?.payment_currency;
  const paymentCreate = summary.mortgage_payment_create ?? null;
  const property = glance?.kind === "property" ? glance.property : undefined;
  const mortgage = glance?.kind === "mortgage" ? glance.mortgage : undefined;

  return (
    <AccountDetailSharedLayout
      title={data.ts.name}
      titleRow={
        <DeptoHeader
          title={data.ts.name}
          glance={glance ?? undefined}
          exportPath={`/api/accounts/${summary.account_id}/export.xlsx`}
          loading={loading}
        />
      }
      strip={null}
      loading={loading}
    >
      {/* Self-gates on the server's import specs (a capability): hidden until they arrive. */}
      <AccountImportSection accountId={summary.account_id} displayUnit={displayUnit} />

      {glance === null ? (
        <PageGridTile id="depto-none">
          <p className="muted">{t("accountDetail.depto.noLedger")}</p>
        </PageGridTile>
      ) : isMortgage ? (
        <>
          <DeptoBalanceBand
            balance={mortgage?.balance}
            asOf={glance?.as_of}
            unit={unit}
            loanCurrency={loanCurrency}
            loading={loading}
          />
          {mortgage?.projection && loanCurrency && payCurrency ? (
            <DeptoProjection
              balance={mortgage.balance}
              projection={mortgage.projection}
              unit={unit}
              loanCurrency={loanCurrency}
              payCurrency={payCurrency}
            />
          ) : null}
          <PageGridTile id="depto-payments">
            <h2>{t("accountDetail.depto.paymentsTitle")}</h2>
            <div className={loadableClass(loading)} aria-busy={loading || undefined}>
              {mortgage && loanCurrency && payCurrency ? (
                <DeptoPaymentsList
                  scope={{ accountId: summary.account_id }}
                  payments={{ ...mortgage.payments, next: mortgage.payments.next ? [mortgage.payments.next] : [] }}
                  unit={unit}
                  loanCurrency={loanCurrency}
                  payCurrency={payCurrency}
                  onRegisterPayment={paymentCreate ? () => setPaymentOpen(true) : null}
                />
              ) : null}
            </div>
          </PageGridTile>
          {paymentCreate ? (
            <Modal
              open={paymentOpen}
              onClose={() => setPaymentOpen(false)}
              title={t("accountDetail.depto.registerPayment")}
              closeAriaLabel={t("accountDetail.checking.monthModalClose")}
            >
              <MortgagePaymentForm accountId={summary.account_id} displayUnit={displayUnit} schema={paymentCreate} />
            </Modal>
          ) : null}
          {mortgage ? (
            <PageGridTile id="depto-movements">
              <DeptoMovementsToggle count={mortgage.movement_count} onToggle={() => setFlowsOpen((v) => !v)} />
            </PageGridTile>
          ) : null}
          {flowsOpen ? (
            <AccountFlowsSection
              addMovementsForm={addMovementsForm}
              accountId={summary.account_id}
              unitsKind={summary.units_kind}
            />
          ) : null}
        </>
      ) : (
        <>
          <DeptoPropertyBands
            glance={property}
            unit={unit}
            loanCurrency={loanCurrency}
            loading={loading}
            onToggleMovements={() => setFlowsOpen((v) => !v)}
          />
          {flowsOpen ? (
            <AccountFlowsSection
              addMovementsForm={addMovementsForm}
              accountId={summary.account_id}
              unitsKind={summary.units_kind}
            />
          ) : null}
        </>
      )}
    </AccountDetailSharedLayout>
  );
}
