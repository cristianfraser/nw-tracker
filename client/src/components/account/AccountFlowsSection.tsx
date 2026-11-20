import type { ReactNode } from "react";
import { useTranslation } from "../../i18n";
import { FlowsPanel } from "./FlowsPanel";
import { PageGridTile } from "../layout/PageGridTile";

export function AccountFlowsSection({
  addMovementsForm,
  accountId,
  unitsKind,
  unitsAsColumn,
  title,
  className,
}: {
  /** Brokerage manual movement entry, rendered under the Flujos heading. */
  addMovementsForm?: ReactNode;
  accountId: number;
  unitsKind?: "shares" | "coin" | "contracts";
  /** The account holds units (its position has a unit count): the list shows them as a column. */
  unitsAsColumn?: boolean;
  /** The section's heading (default «Flujos»). */
  title?: string;
  /** The tile's layout class (its span on a page that places it beside another). */
  className?: string;
}) {
  const { t } = useTranslation();

  return (
    <PageGridTile id="flows" className={className}>
      <h2>{title ?? t("accountDetail.flowsTitle")}</h2>
      {addMovementsForm}
      <FlowsPanel
        kind="account"
        accountId={accountId}
        unitsKind={unitsKind}
        unitsAsColumn={unitsAsColumn}
        showPersonalOnlyFilter
      />
    </PageGridTile>
  );
}
