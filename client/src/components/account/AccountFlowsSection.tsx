import type { ReactNode } from "react";
import { useTranslation } from "../../i18n";
import { FlowsPanel } from "./FlowsPanel";
import { PageGridTile } from "../layout/PageGridTile";

export function AccountFlowsSection({
  addMovementsForm,
  accountId,
  unitsKind,
}: {
  /** Brokerage manual movement entry, rendered under the Flujos heading. */
  addMovementsForm?: ReactNode;
  accountId: number;
  unitsKind?: "shares" | "coin";
}) {
  const { t } = useTranslation();

  return (
    <PageGridTile id="flows">
      <h2>{t("accountDetail.flowsTitle")}</h2>
      {addMovementsForm}
      <FlowsPanel kind="account" accountId={accountId} unitsKind={unitsKind} showPersonalOnlyFilter />
    </PageGridTile>
  );
}
