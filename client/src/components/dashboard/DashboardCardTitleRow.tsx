import { Link } from "react-router-dom";
import { cn } from "../../cn";
import { parseRgbTriplet, readableTextOnRgb } from "../../chartColors";
import { Pill } from "../ui/Pill";

type Props = {
  label: string;
  /** When set, the label is a client-side link (e.g. nav child on a group page). */
  titleTo?: string;
  /**
   * The bucket's own colour (`color_rgb` of its nav node, as `r,g,b`): the title is then a pill in
   * that colour, the same pill the expense categories use. No colour = plain text.
   */
  colorRgb?: string | null;
};

/** Card title row — label only (the old period balance-Δ chip was removed with the
 * all-periods card metrics restructure; the Δ now lives in the metric rows). */
export function DashboardCardTitleRow({ label, titleTo, colorRgb }: Props) {
  const rgb = parseRgbTriplet(colorRgb);
  const text = rgb ? (
    <Pill
      label={label}
      backgroundColor={`rgb(${rgb[0]},${rgb[1]},${rgb[2]})`}
      textColor={readableTextOnRgb(rgb)}
    />
  ) : (
    label
  );
  const labelNode = titleTo ? <Link to={titleTo}>{text}</Link> : text;
  return (
    <div className={cn("card-title-row title-container")}>
      <span className="title card-title-row__label">{labelNode}</span>
    </div>
  );
}
