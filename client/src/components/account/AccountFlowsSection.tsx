import type { ReactNode } from "react";
import { useTranslation } from "../../i18n";
import type { FlowsTableRow } from "../../accountFlows";
import { FlowsTable } from "./FlowsTable";
import styles from "../../pages/AccountDetailPage.module.css";

export function AccountFlowsSection({
  hint,
  addMovementsForm,
  rows,
  totalCount,
  movementsOnlyPersonalDeposits,
  onMovementsOnlyPersonalDepositsChange,
  movementUnitsKind,
  collapsedVisibleRows,
}: {
  hint: ReactNode;
  /** Brokerage manual movement entry, rendered under the Flujos heading. */
  addMovementsForm?: ReactNode;
  rows: readonly FlowsTableRow[];
  totalCount: number;
  movementsOnlyPersonalDeposits: boolean;
  onMovementsOnlyPersonalDepositsChange: (checked: boolean) => void;
  movementUnitsKind?: (slug: string) => "shares" | "coin";
  collapsedVisibleRows: number;
}) {
  const { t } = useTranslation();

  return (
    <>
      <h2>{t("accountDetail.flowsTitle")}</h2>
      {hint}
      {addMovementsForm}
      <label className={styles.flowsFilterToggle}>
        <input
          type="checkbox"
          checked={movementsOnlyPersonalDeposits}
          onChange={(e) => onMovementsOnlyPersonalDepositsChange(e.target.checked)}
        />
        {t("accountDetail.flowsPersonalOnly")}
      </label>
      <FlowsTable
        rows={rows}
        collapsedVisibleRows={collapsedVisibleRows}
        movementUnitsKind={movementUnitsKind}
        totalCount={totalCount}
      />
    </>
  );
}
