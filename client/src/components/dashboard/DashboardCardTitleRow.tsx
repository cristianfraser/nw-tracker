import { Link } from "react-router-dom";
import { cn } from "../../cn";
import { TitleBalanceDeltaFlow } from "./TitleBalanceDeltaFlow";

type Props = {
  /** Omit to render only the Δ (e.g. the hero card, whose name repeats the page title). */
  label?: string;
  /** When set, the label is a client-side link (e.g. nav child on a group page). */
  titleTo?: string;
  /** Period balance Δ (net deposits + nominal P/L); matches card metric rows. */
  balanceDelta: number | null;
  showUsd: boolean;
  cardSlug: string;
  animated?: boolean;
  placeholderPhase?: boolean;
};

export function DashboardCardTitleRow({
  label,
  titleTo,
  balanceDelta,
  showUsd,
  cardSlug,
  animated = true,
  placeholderPhase = false,
}: Props) {
  const labelNode = titleTo ? <Link to={titleTo}>{label}</Link> : label;
  return (
    <div className={cn("card-title-row title-container", label == null && "card-title-row--no-label")}>
      {label != null ? <span className="title card-title-row__label">{labelNode}</span> : null}
      <div className="number-container">
        <TitleBalanceDeltaFlow
          delta={balanceDelta}
          showUsd={showUsd}
          animated={animated}
          placeholderPhase={placeholderPhase}
          mountSeedId={`${cardSlug}:title-balance-delta`}
          className="card-title-row__delta"
        />
      </div>
    </div>
  );
}
