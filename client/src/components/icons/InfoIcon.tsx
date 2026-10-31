import { iconSvgProps, type IconProps } from "./iconProps";

/** An «i» in a circle: more detail on hover / tap. */
export function InfoIcon(props: IconProps) {
  return (
    <svg {...iconSvgProps(props)}>
      <circle cx="12" cy="12" r="9" />
      <line x1="12" y1="11" x2="12" y2="16.5" />
      <circle cx="12" cy="7.75" r="0.6" fill="currentColor" />
    </svg>
  );
}
