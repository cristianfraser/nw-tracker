import { useState } from "react";
import { useTranslation } from "../../i18n";
import { AccountDetailSharedLayout } from "./AccountDetailSharedLayout";
import { PageGridTile } from "../../components/layout/PageGridTile";
import { ExportToolbarButton } from "../../components/export/ExportModal";
import { AccountImportSection } from "../../components/account/AccountImportSection";
import { CheckingLedgerAnchorForm } from "../../components/account/CheckingLedgerAnchorForm";
import { CheckingStatement } from "../../components/account/CheckingStatement";
import { GlanceTitleLine } from "../../components/account/PositionGlance";
import { Modal } from "../../components/ui/Modal";
import { useAccountMovementForm } from "./accountSurfaces";
import type { AccountDetailPageData } from "./useAccountDetailPageData";

type Props = {
  data: AccountDetailPageData;
};

/**
 * A cuenta corriente / cuenta vista: a balance and its ledger. The title line carries today's balance;
 * the statement (`CheckingStatement`) is the page, its balance strip following the month
 * in view. The ledger anchor is the statement's first line, edited in a modal.
 */
export function CheckingAccountDetailPage({ data }: Props) {
  const { t } = useTranslation();
  const { summary, displayUnit, checkingGlance: glance, checkingCartolaMonths } = data;
  const loading = data.contentLoading;
  const { form: addMovementsForm } = useAccountMovementForm(data);
  const [anchorOpen, setAnchorOpen] = useState(false);

  return (
    <AccountDetailSharedLayout
      title={data.ts.name}
      titleRow={
        <GlanceTitleLine
          title={data.ts.name}
          value={glance ? { value: glance.balance, currency: glance.currency } : null}
          day={null}
          loading={glance === undefined}
        />
      }
      strip={null}
      toolbar={<ExportToolbarButton exportPath={`/api/accounts/${summary.account_id}/export.xlsx`} />}
      loading={loading}
    >
      <PageGridTile id="statement">
        <CheckingStatement
          accountId={summary.account_id}
          glance={glance}
          loading={loading}
          onAdjustOpening={() => setAnchorOpen(true)}
        />
      </PageGridTile>

      {addMovementsForm ? (
        <PageGridTile id="add-movement">
          <h2>{t("accountDetail.checking.statement.addMovement")}</h2>
          {addMovementsForm}
        </PageGridTile>
      ) : null}

      {/* Self-gates on the server's import specs (a capability): hidden until they arrive. */}
      <AccountImportSection accountId={summary.account_id} displayUnit={displayUnit} />

      <Modal
        open={anchorOpen}
        onClose={() => setAnchorOpen(false)}
        title={t("accountDetail.checking.ledgerAnchorTitle")}
        closeAriaLabel={t("accountDetail.checking.monthModalClose")}
      >
        {checkingCartolaMonths ? (
          <CheckingLedgerAnchorForm
            accountId={summary.account_id}
            displayUnit={displayUnit}
            ledgerAnchor={checkingCartolaMonths.ledger_anchor}
            cartolaDerivedAnchor={checkingCartolaMonths.cartola_derived_anchor}
          />
        ) : null}
      </Modal>
    </AccountDetailSharedLayout>
  );
}
