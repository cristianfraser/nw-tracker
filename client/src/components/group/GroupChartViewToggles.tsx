import { useTranslation } from "../../i18n";

export type GroupChartViewTogglesProps = {
  grouped: boolean;
  onGroupedChange: (value: boolean) => void;
  showAccumulatedDeposits?: boolean;
  accumulatedDeposits?: boolean;
  onAccumulatedDepositsChange?: (value: boolean) => void;
};

export function GroupChartViewToggles({
  grouped,
  onGroupedChange,
  showAccumulatedDeposits = true,
  accumulatedDeposits = true,
  onAccumulatedDepositsChange,
}: GroupChartViewTogglesProps) {
  const { t } = useTranslation();

  return (
    <div className="group-chart-view-toggles">
      <label className="group-chart-view-toggles__label">
        <input type="checkbox" checked={grouped} onChange={(e) => onGroupedChange(e.target.checked)} />
        <span>{t("groupPage.chartToggleGrouped")}</span>
      </label>
      {showAccumulatedDeposits && onAccumulatedDepositsChange ? (
        <label
          className="group-chart-view-toggles__label"
          title={t("groupPage.chartToggleAccumulatedDepositsTitle")}
        >
          <input
            type="checkbox"
            checked={accumulatedDeposits}
            onChange={(e) => onAccumulatedDepositsChange(e.target.checked)}
          />
          <span>{t("groupPage.chartToggleAccumulatedDeposits")}</span>
        </label>
      ) : null}
    </div>
  );
}
