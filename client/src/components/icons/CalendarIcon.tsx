import { iconSvgProps, type IconProps } from "./iconProps";

/** A page of a calendar: a day. */
export function CalendarIcon(props: IconProps) {
  return (
    <svg {...iconSvgProps(props)}>
      <rect x="3.5" y="5" width="17" height="15.5" rx="2" />
      <line x1="3.5" y1="10" x2="20.5" y2="10" />
      <line x1="8" y1="3" x2="8" y2="7" />
      <line x1="16" y1="3" x2="16" y2="7" />
    </svg>
  );
}
