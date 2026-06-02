import { Link } from "react-router-dom";
import { TitleBalanceDeltaFlow } from "./TitleBalanceDeltaFlow";

type Props = {
  label: string;
  /** When set, the label is a client-side link (e.g. nav child on a group page). */
  titleTo?: string;
  /** Period balance Δ (net deposits + nominal P/L); matches card metric rows. */
  balanceDelta: number | null;
  showUsd: boolean;
  cardSlug: string;
  animated?: boolean;
};

export function DashboardCardTitleRow({
  label,
  titleTo,
  balanceDelta,
  showUsd,
  cardSlug,
  animated = true,
}: Props) {
  const labelNode = titleTo ? <Link to={titleTo}>{label}</Link> : label;
  return (
    <div className="card-title-row title-container">
      <span className="title card-title-row__label">{labelNode}</span>
      <div className="number-container">
        <TitleBalanceDeltaFlow
          delta={balanceDelta}
          showUsd={showUsd}
          animated={animated}
          mountSeedId={`${cardSlug}:title-balance-delta`}
          className="card-title-row__delta"
        />
      </div>
    </div>
  );
}
