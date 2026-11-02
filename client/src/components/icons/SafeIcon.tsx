import { iconSvgProps, type IconProps } from "./iconProps";

/** A safe: money put aside into savings and investments. A box, its dial, a hinge edge. */
export function SafeIcon(props: IconProps) {
  return (
    <svg {...iconSvgProps(props)}>
      <rect x="3.5" y="3.5" width="17" height="17" rx="2" />
      <circle cx="12.5" cy="12" r="3.5" />
      <line x1="6.5" y1="8" x2="6.5" y2="16" />
    </svg>
  );
}
