import { DeltaMetricFlow } from "./DeltaMetricFlow";

type Props = {
  label: string;
  /** Period balance Δ (net deposits + nominal P/L); matches card metric rows. */
  balanceDelta: number | null;
  showUsd: boolean;
  cardSlug: string;
  animated?: boolean;
};

export function DashboardCardTitleRow({
  label,
  balanceDelta,
  showUsd,
  cardSlug,
  animated = true,
}: Props) {
  return (
    <div className="card-title-row">
      <span className="card-title-row__label">{label}</span>
      <DeltaMetricFlow
        delta={balanceDelta}
        showUsd={showUsd}
        animated={animated}
        mountSeedId={`${cardSlug}:title-balance-delta`}
        deltaFormat="absolute"
        className="card-title-row__delta"
      />
    </div>
  );
}
