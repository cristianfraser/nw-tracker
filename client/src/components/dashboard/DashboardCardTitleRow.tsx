import { Link } from "react-router-dom";
import { cn } from "../../cn";

type Props = {
  label: string;
  /** When set, the label is a client-side link (e.g. nav child on a group page). */
  titleTo?: string;
};

/** Card title row — label only (the old period balance-Δ chip was removed with the
 * all-periods card metrics restructure; the Δ now lives in the metric rows). */
export function DashboardCardTitleRow({ label, titleTo }: Props) {
  const labelNode = titleTo ? <Link to={titleTo}>{label}</Link> : label;
  return (
    <div className={cn("card-title-row title-container")}>
      <span className="title card-title-row__label">{labelNode}</span>
    </div>
  );
}
