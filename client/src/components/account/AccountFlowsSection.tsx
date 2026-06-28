import type { ReactNode } from "react";
import { useTranslation } from "../../i18n";
import { FlowsPanel } from "./FlowsPanel";

export function AccountFlowsSection({
  hint,
  addMovementsForm,
  accountId,
  movementUnitsKind,
}: {
  hint: ReactNode;
  /** Brokerage manual movement entry, rendered under the Flujos heading. */
  addMovementsForm?: ReactNode;
  accountId: number;
  movementUnitsKind?: (slug: string) => "shares" | "coin";
}) {
  const { t } = useTranslation();

  return (
    <>
      <h2>{t("accountDetail.flowsTitle")}</h2>
      {hint}
      {addMovementsForm}
      <FlowsPanel kind="account" accountId={accountId} movementUnitsKind={movementUnitsKind} showPersonalOnlyFilter />
    </>
  );
}
