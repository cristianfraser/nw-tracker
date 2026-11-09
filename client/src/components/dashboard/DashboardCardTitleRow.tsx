import { Link } from "react-router-dom";
import { cn } from "../../cn";
import { mutedPillBackgroundRgb, parseRgbTriplet, tintedTextOnRgb } from "../../chartColors";
import { Pill } from "../ui/Pill";

type Props = {
  label: string;
  /** When set, the label is a client-side link (e.g. nav child on a group page). */
  titleTo?: string;
  /**
   * The bucket's own colour (`color_rgb` of its nav node, as `r,g,b`): the title is then a pill in
   * that colour (muted: `mutedPillBackgroundRgb`), the same pill the expense categories use. No
   * colour = plain text.
   */
  colorRgb?: string | null;
};

/** Card title row — label only; the Δ lives in the metric rows. */
export function DashboardCardTitleRow({ label, titleTo, colorRgb }: Props) {
  const rgb = parseRgbTriplet(colorRgb);
  const text = rgb ? (
    <Pill
      size="small"
      uppercase={false}
      // The card title uppercases its text; the pill keeps the label as written.
      style={{ textTransform: "none" }}
      label={label}
      backgroundColor={mutedPillBackgroundRgb(rgb)}
      textColor={tintedTextOnRgb(rgb)}
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
